use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};

use crate::frame::{Frame, PinnedProgram, Target};
use crate::{landlock, roots, seccomp, sys, Level, RunKind};

pub const EXIT_SANDBOX_SETUP: i32 = 76;
pub const EXIT_EXEC_FAILED: i32 = 127;
pub const READY_FD: RawFd = 5;

const RESOLVE_NO_XDEV: u64 = 0x01;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;

#[derive(Debug)]
pub struct StartedSignal {
    fd: RawFd,
}

impl StartedSignal {
    pub fn confine(self, kept_fds: &[RawFd]) -> Result<(), String> {
        let mut kept = kept_fds.to_vec();
        kept.push(self.fd);
        let result = confine_host_threads(&kept);
        let line: &[u8] = match &result {
            Ok(()) => b"started\n",
            Err(_) => b"error host-filter\n",
        };
        let _ = sys::write_all(self.fd, line);
        unsafe { libc::close(self.fd) };
        result
    }
}

#[derive(Debug)]
pub struct HostHandoff {
    pub level: Level,
    pub landlock_abi: u32,
    pub args: Vec<String>,
    pub started: StartedSignal,
}

#[derive(Debug)]
pub enum ExecOutcome {
    Host(HostHandoff),
    Exit(i32),
}

struct Failure {
    code: &'static str,
    error: io::Error,
}

fn fail(code: &'static str) -> impl FnOnce(io::Error) -> Failure {
    move |error| Failure { code, error }
}

fn parse_fd(args: &[String], name: &str) -> Option<RawFd> {
    let at = args.iter().position(|arg| arg == name)?;
    args.get(at + 1)?.parse().ok().filter(|fd: &RawFd| *fd > 2)
}

pub fn exec_main(args: &[String]) -> ExecOutcome {
    if args.first().map(String::as_str) == Some("--probe") {
        return ExecOutcome::Exit(0);
    }
    let (Some(policy), Some(ready)) = (parse_fd(args, "--policy-fd"), parse_fd(args, "--ready-fd"))
    else {
        let _ = sys::write_all(2, b"[ardia] usage: exec --policy-fd N --ready-fd N\n");
        return ExecOutcome::Exit(64);
    };
    if ready != READY_FD {
        let _ = sys::write_all(2, b"[ardia] the readiness pipe must be fd 5\n");
        return ExecOutcome::Exit(64);
    }
    match enter(sys::owned(policy)) {
        Ok(handoff) => ExecOutcome::Host(handoff),
        Err(failure) => {
            let _ = sys::write_all(
                2,
                format!(
                    "[ardia] the sandbox couldn't be set up ({}): {}\n",
                    failure.code, failure.error
                )
                .as_bytes(),
            );
            let _ = sys::write_all(READY_FD, format!("error {}\n", failure.code).as_bytes());
            ExecOutcome::Exit(EXIT_SANDBOX_SETUP)
        }
    }
}

fn open_target(target: &Target) -> io::Result<Option<OwnedFd>> {
    match target {
        Target::Path(path) => sys::open_path(path).map(Some),
        Target::Fd(_) => Ok(None),
    }
}

pub fn unexpected_mounts(
    mount_points: &[PathBuf],
    trees: &[PathBuf],
    expected: &[PathBuf],
) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = mount_points
        .iter()
        .filter(|point| {
            trees
                .iter()
                .any(|tree| point.as_path() != tree.as_path() && point.starts_with(tree))
        })
        .filter(|point| !expected.contains(point))
        .cloned()
        .collect();
    found.sort();
    found.dedup();
    found
}

fn check_mount_view(frame: &Frame) -> io::Result<()> {
    if frame.mount_checks.is_empty() {
        return Ok(());
    }
    let points = roots::mount_points()?;
    let unexpected = unexpected_mounts(&points, &frame.mount_checks, &frame.expected_mounts);
    match unexpected.first() {
        None => Ok(()),
        Some(point) => Err(sys::invalid(format!(
            "an unexpected filesystem is mounted at {} inside a granted folder",
            point.display()
        ))),
    }
}

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

pub fn open_beneath(dir: RawFd, relative: &str) -> io::Result<OwnedFd> {
    let name = sys::cstring(Path::new(relative))?;
    let how = OpenHow {
        flags: (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
        mode: 0,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_XDEV | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
    };
    let fd = sys::check_long(unsafe {
        libc::syscall(
            libc::SYS_openat2,
            dir,
            name.as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        )
    })?;
    let fd = sys::owned(fd as RawFd);
    if sys::fstat(fd.as_raw_fd())?.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(sys::invalid("the entry isn't a regular file"));
    }
    Ok(fd)
}

fn check_entry(frame: &Frame) -> io::Result<()> {
    let Some(entry) = &frame.entry else {
        return Ok(());
    };
    let dir = match &frame.cwd {
        Target::Path(path) => sys::open_dir(path)?,
        Target::Fd(fd) => sys::dup_above(*fd, 3)?,
    };
    open_beneath(dir.as_raw_fd(), entry).map(drop).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("the entry {entry} can't be opened inside the plugin folder on its own filesystem: {error}"),
        )
    })
}

fn open_program(program: &PinnedProgram) -> io::Result<OwnedFd> {
    let fd = sys::openat(
        libc::AT_FDCWD,
        &program.path,
        libc::O_RDONLY | libc::O_NOFOLLOW,
        0,
    )?;
    if sys::identity(fd.as_raw_fd())? != (program.device, program.inode) {
        return Err(sys::invalid(
            "the program inside the sandbox isn't the one the broker verified",
        ));
    }
    Ok(fd)
}

fn enter(policy: OwnedFd) -> Result<HostHandoff, Failure> {
    let bytes = sys::read_to_end_capped(policy.as_raw_fd(), crate::frame::MAX_FRAME)
        .map_err(fail("policy-read"))?;
    drop(policy);
    let frame = Frame::decode(&bytes).map_err(fail("policy-invalid"))?;
    if frame.expected_parent > 0 {
        sys::die_with_parent(frame.expected_parent).map_err(fail("parent-gone"))?;
    }
    sys::set_no_new_privs().map_err(fail("no-new-privs"))?;
    if !frame.baseline.is_empty() {
        let program = seccomp::from_bytes(&frame.baseline).map_err(fail("baseline-invalid"))?;
        seccomp::install(&program, false).map_err(fail("baseline"))?;
    }
    let kernel = landlock::kernel_abi().map_err(|why| Failure {
        code: "landlock-unavailable",
        error: io::Error::new(
            io::ErrorKind::Unsupported,
            format!("{}: {why}", crate::LANDLOCK_MISSING),
        ),
    })?;
    let minimum = match frame.kind {
        RunKind::Host => landlock::HOST_MIN_ABI,
        RunKind::Sidecar => landlock::SIDECAR_MIN_ABI,
    };
    if frame.landlock_abi < minimum || kernel < frame.landlock_abi {
        return Err(Failure {
            code: "landlock-abi",
            error: sys::invalid(format!(
                "the policy wants Landlock ABI {} and the kernel has {kernel}",
                frame.landlock_abi
            )),
        });
    }
    check_mount_view(&frame).map_err(fail("unexpected-mount"))?;
    check_entry(&frame).map_err(fail("entry-check"))?;
    let program_fd = match &frame.program {
        Some(program) => Some(open_program(program).map_err(fail("program-identity"))?),
        None => None,
    };
    let mut opened = Vec::new();
    let mut rules = Vec::new();
    for rule in &frame.rules {
        match open_target(&rule.target).map_err(fail("rule-target"))? {
            Some(fd) => {
                rules.push((fd.as_raw_fd(), rule.rights));
                opened.push(fd);
            }
            None => {
                if let Target::Fd(fd) = rule.target {
                    rules.push((fd, rule.rights));
                }
            }
        }
    }
    landlock::restrict_self(frame.landlock_abi, &rules).map_err(fail("landlock"))?;
    drop(opened);
    if frame.kind == RunKind::Sidecar {
        let program = seccomp::from_bytes(&frame.final_filter).map_err(fail("final-invalid"))?;
        seccomp::install(&program, false).map_err(fail("final"))?;
    }
    match &frame.cwd {
        Target::Path(path) => {
            let path = sys::cstring(path).map_err(fail("cwd"))?;
            sys::check(unsafe { libc::chdir(path.as_ptr()) }).map_err(fail("cwd"))?;
        }
        Target::Fd(fd) => {
            sys::check(unsafe { libc::fchdir(*fd) }).map_err(fail("cwd"))?;
        }
    }
    let line = format!("accepted {} {}\n", frame.level.name(), frame.landlock_abi);
    sys::write_all(READY_FD, line.as_bytes()).map_err(fail("accepted"))?;
    match (frame.kind, frame.program, program_fd) {
        (RunKind::Sidecar, Some(program), Some(fd)) => {
            let kept = if program.script {
                vec![]
            } else {
                vec![fd.as_raw_fd()]
            };
            keep_only(&kept).map_err(fail("close-fds"))?;
            sys::check(unsafe { libc::fcntl(READY_FD, libc::F_SETFD, libc::FD_CLOEXEC) })
                .map_err(fail("ready-fd"))?;
            if program.script {
                std::mem::forget(fd);
                exec_path(&program.path, &frame.argv, &frame.env)
            } else {
                let raw = fd.as_raw_fd();
                std::mem::forget(fd);
                exec_fd(raw, &frame.argv, &frame.env)
            }
        }
        (RunKind::Sidecar, _, _) => Err(Failure {
            code: "program-missing",
            error: sys::invalid("a sidecar frame came without its program"),
        }),
        (RunKind::Host, _, _) => {
            keep_only(&[]).map_err(fail("close-fds"))?;
            Ok(HostHandoff {
                level: frame.level,
                landlock_abi: frame.landlock_abi,
                args: frame.host_args,
                started: StartedSignal { fd: READY_FD },
            })
        }
    }
}

fn keep_only(extra: &[RawFd]) -> io::Result<()> {
    let mut kept = vec![0, 1, 2, 3, READY_FD];
    kept.extend_from_slice(extra);
    sys::close_all_except(&kept)
}

fn cstrings(items: &[String]) -> Option<Vec<CString>> {
    items
        .iter()
        .map(|item| CString::new(item.as_bytes()).ok())
        .collect()
}

fn pointers(items: &[CString]) -> Vec<*const libc::c_char> {
    let mut list: Vec<*const libc::c_char> = items.iter().map(|item| item.as_ptr()).collect();
    list.push(std::ptr::null());
    list
}

fn exec_failed(argv: &[String]) -> ! {
    let error = sys::last_error();
    let name = argv.first().map(String::as_str).unwrap_or("the program");
    let _ = sys::write_all(
        2,
        format!("[ardia] {name} couldn't start: {error}\n").as_bytes(),
    );
    let _ = sys::write_all(READY_FD, b"error exec\n");
    unsafe { libc::_exit(EXIT_EXEC_FAILED) }
}

fn exec_fd(fd: RawFd, argv: &[String], env: &[String]) -> ! {
    if let (Some(args), Some(vars)) = (cstrings(argv), cstrings(env)) {
        let (args, vars) = (pointers(&args), pointers(&vars));
        sys::check(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) }).ok();
        unsafe {
            libc::syscall(
                libc::SYS_execveat,
                fd,
                c"".as_ptr(),
                args.as_ptr(),
                vars.as_ptr(),
                libc::AT_EMPTY_PATH,
            )
        };
    }
    exec_failed(argv)
}

fn exec_path(path: &Path, argv: &[String], env: &[String]) -> ! {
    if let (Ok(path), Some(args), Some(vars)) = (sys::cstring(path), cstrings(argv), cstrings(env))
    {
        let (args, vars) = (pointers(&args), pointers(&vars));
        unsafe { libc::execve(path.as_ptr(), args.as_ptr(), vars.as_ptr()) };
    }
    exec_failed(argv)
}

fn confine_host_threads(kept_fds: &[RawFd]) -> Result<(), String> {
    sys::close_all_except(kept_fds)
        .map_err(|error| format!("the extra fds couldn't be closed: {error}"))?;
    let program = seccomp::compile(&seccomp::host_final(std::process::id() as i32))
        .map_err(|error| format!("the host filter didn't compile: {error}"))?;
    seccomp::install(&program, true)
        .map_err(|error| format!("the host filter couldn't be installed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(items: &[&str]) -> Vec<PathBuf> {
        items.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn only_expected_mounts_may_sit_inside_granted_trees() {
        let points = paths(&[
            "/",
            "/usr",
            "/usr/local",
            "/proc",
            "/proc/sys",
            "/run/ardia/plugin",
            "/run/ardia/program",
            "/run/ardia/program/bin/tool",
            "/run/ardia/plugin/nested",
        ]);
        let trees = paths(&["/usr", "/run/ardia/plugin", "/run/ardia/program"]);
        let expected = paths(&["/run/ardia/program/bin/tool"]);
        assert_eq!(
            unexpected_mounts(&points, &trees, &expected),
            paths(&["/run/ardia/plugin/nested", "/usr/local"])
        );
        assert!(unexpected_mounts(&paths(&["/usr", "/proc/sys"]), &trees, &expected).is_empty());
    }

    #[test]
    fn the_entry_must_stay_beneath_its_folder_and_filesystem() {
        let dir = std::env::temp_dir().join(format!("jail-entry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::write(dir.join("dist/index.js"), "x").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.join("dist/link.js")).unwrap();
        let root = sys::open_dir(&dir).unwrap();
        assert!(open_beneath(root.as_raw_fd(), "dist/index.js").is_ok());
        assert!(open_beneath(root.as_raw_fd(), "dist/link.js").is_err());
        assert!(open_beneath(root.as_raw_fd(), "../etc/passwd").is_err());
        assert!(open_beneath(root.as_raw_fd(), "dist").is_err());
        let proc_root = sys::open_dir(Path::new("/")).unwrap();
        assert!(open_beneath(proc_root.as_raw_fd(), "proc/self/status").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
