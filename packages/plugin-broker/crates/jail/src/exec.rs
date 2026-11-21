use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

use crate::frame::{Frame, Target};
use crate::{landlock, seccomp, sys, Level, RunKind};

pub const EXIT_SANDBOX_SETUP: i32 = 76;
pub const EXIT_EXEC_FAILED: i32 = 127;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostHandoff {
    pub level: Level,
    pub landlock_abi: u32,
    pub args: Vec<String>,
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
    match enter(sys::owned(policy), ready) {
        Ok(Entered::Host(handoff)) => ExecOutcome::Host(handoff),
        Err(failure) => {
            let _ = sys::write_all(ready, format!("error {}\n", failure.code).as_bytes());
            let _ = sys::write_all(
                2,
                format!(
                    "[ardia] the sandbox couldn't be set up ({}): {}\n",
                    failure.code, failure.error
                )
                .as_bytes(),
            );
            ExecOutcome::Exit(EXIT_SANDBOX_SETUP)
        }
    }
}

enum Entered {
    Host(HostHandoff),
}

fn open_target(target: &Target) -> io::Result<Option<OwnedFd>> {
    match target {
        Target::Path(path) => sys::open_path(path).map(Some),
        Target::Fd(_) => Ok(None),
    }
}

fn enter(policy: OwnedFd, ready: RawFd) -> Result<Entered, Failure> {
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
    let line = format!("ready {} {}\n", frame.level.name(), frame.landlock_abi);
    sys::write_all(ready, line.as_bytes()).map_err(fail("ready"))?;
    match (frame.kind, frame.program) {
        (RunKind::Sidecar, Some(program)) => {
            keep_only_standard_fds_and(program.fd).map_err(fail("close-fds"))?;
            let flags = if program.script { 0 } else { libc::FD_CLOEXEC };
            sys::check(unsafe { libc::fcntl(program.fd, libc::F_SETFD, flags) })
                .map_err(fail("program-fd"))?;
            exec_pinned(program.fd, &frame.argv, &frame.env)
        }
        _ => {
            sys::close_range(4, u32::MAX, sys::CLOSE_RANGE_UNSHARE).map_err(fail("close-fds"))?;
            Ok(Entered::Host(HostHandoff {
                level: frame.level,
                landlock_abi: frame.landlock_abi,
                args: frame.host_args,
            }))
        }
    }
}

fn keep_only_standard_fds_and(fd: RawFd) -> io::Result<()> {
    if fd <= 3 {
        return Err(sys::invalid("the program fd sits among the standard fds"));
    }
    if fd > 4 {
        sys::close_range(4, (fd - 1) as u32, sys::CLOSE_RANGE_UNSHARE)?;
    }
    sys::close_range((fd + 1) as u32, u32::MAX, 0)
}

fn cstrings(items: &[String]) -> Option<Vec<CString>> {
    items
        .iter()
        .map(|item| CString::new(item.as_bytes()).ok())
        .collect()
}

fn exec_pinned(fd: RawFd, argv: &[String], env: &[String]) -> ! {
    if let (Some(args), Some(vars)) = (cstrings(argv), cstrings(env)) {
        let mut arg_pointers: Vec<*const libc::c_char> = args.iter().map(|a| a.as_ptr()).collect();
        arg_pointers.push(std::ptr::null());
        let mut env_pointers: Vec<*const libc::c_char> = vars.iter().map(|v| v.as_ptr()).collect();
        env_pointers.push(std::ptr::null());
        unsafe {
            libc::syscall(
                libc::SYS_execveat,
                fd,
                c"".as_ptr(),
                arg_pointers.as_ptr(),
                env_pointers.as_ptr(),
                libc::AT_EMPTY_PATH,
            )
        };
    }
    let error = sys::last_error();
    let name = argv.first().map(String::as_str).unwrap_or("the program");
    let _ = sys::write_all(
        2,
        format!("[ardia] {name} couldn't start: {error}\n").as_bytes(),
    );
    unsafe { libc::_exit(EXIT_EXEC_FAILED) }
}

pub fn confine_host(kept_fds: &[RawFd]) -> Result<(), String> {
    sys::close_all_except(kept_fds)
        .map_err(|error| format!("the extra fds couldn't be closed: {error}"))?;
    let program = seccomp::compile(&seccomp::host_final(std::process::id() as i32))
        .map_err(|error| format!("the host filter didn't compile: {error}"))?;
    seccomp::install(&program, true)
        .map_err(|error| format!("the host filter couldn't be installed: {error}"))
}
