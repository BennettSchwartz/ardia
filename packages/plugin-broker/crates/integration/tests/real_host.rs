#![cfg(target_os = "linux")]

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use jail::{Level, Quiet, SpawnRequest, Supervisor, SupervisorConfig, Work};
use serde_json::{json, Value};

const WAIT: Duration = Duration::from_secs(10);

fn launcher() -> PathBuf {
    std::env::var_os("JAIL_IT_LAUNCHER")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_ardia-plugins")))
}

const HOST_PROBES: &[&str] = &[
    "socket-unix-stream",
    "socket-unix-dgram",
    "socket-netlink",
    "socket-inet-tcp",
    "socket-inet-udp",
    "socket-inet6-tcp",
    "socket-packet",
    "socketpair-unix-dgram",
    "connect-control-socket",
    "connect-session-bus",
    "connect-abstract-x11",
    "read-home",
    "list-home",
    "read-other-plugin-data",
    "read-browser-proc",
    "signal-outside",
    "ptrace-outside",
    "write-outside",
    "truncate-path-outside",
    "rename-across-roots",
    "inherited-fd",
    "io-uring",
    "tiocsti",
    "unshare-user-namespace",
    "keyctl",
    "bpf",
    "exe-metadata",
    "fcntl-setown-outside",
    "fork",
    "execve-permitted",
    "open-outside-plugin-folder",
    "open-after-confine",
    "mmap-exec",
];

const PINNED_BWRAP: &str = "bubblewrap 0.13.1";

fn required() -> bool {
    std::env::var("ARDIA_JAIL_REQUIRED")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

fn skip_or_fail(test: &str, why: String) {
    assert!(!required(), "{test}: ARDIA_JAIL_REQUIRED is set but {why}");
    eprintln!("SUMMARY {test} not-applicable ({why})");
}

fn committed_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../host/tests/fixtures/sdk-bench")
}

fn build_fixture() -> PathBuf {
    let source = committed_fixture();
    let bundle = source.join("dist/index.js");
    let committed = std::fs::read(&bundle).unwrap();
    let status = Command::new("node")
        .arg(source.join("build.mjs"))
        .status()
        .unwrap_or_else(|error| {
            panic!("required mode builds sdk-bench with node build.mjs: {error}")
        });
    let built = std::fs::read(&bundle).unwrap();
    std::fs::write(&bundle, &committed).unwrap();
    assert!(status.success(), "node build.mjs failed for sdk-bench");
    assert!(built.len() > 1000, "the fresh sdk-bench bundle is empty");
    let out = std::env::temp_dir().join(format!("ri-fixture-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    copy_tree(&source, &out);
    std::fs::write(out.join("dist/index.js"), &built).unwrap();
    eprintln!(
        "FIXTURE sdk-bench rebuilt: {} bytes, identical to the committed bundle: {}",
        built.len(),
        built == committed
    );
    out
}

fn fixture() -> PathBuf {
    static BUILT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    if let Some(path) = std::env::var_os("JAIL_IT_FIXTURE") {
        return PathBuf::from(path);
    }
    if !required() {
        return committed_fixture();
    }
    BUILT.get_or_init(build_fixture).clone()
}

fn pinned_bwrap() -> Option<OwnedFd> {
    let Some(path) = std::env::var_os("ARDIA_BWRAP") else {
        assert!(
            !required(),
            "required mode needs ARDIA_BWRAP pointing at the pinned bwrap"
        );
        return None;
    };
    let fd = open(Path::new(&path), libc::O_RDONLY);
    if required() {
        let version = Command::new(&path).arg("--version").output().unwrap();
        let version = String::from_utf8_lossy(&version.stdout).trim().to_string();
        assert_eq!(version, PINNED_BWRAP, "ARDIA_BWRAP isn't the pinned build");
        assert!(
            jail::elf::needs_no_loader(fd.as_raw_fd()).unwrap(),
            "the pinned bwrap must be static"
        );
    }
    Some(fd)
}

fn open(path: &Path, flags: i32) -> OwnedFd {
    let name = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
    let fd = unsafe { libc::open(name.as_ptr(), flags | libc::O_CLOEXEC) };
    assert!(
        fd >= 0,
        "{}: {}",
        path.display(),
        std::io::Error::last_os_error()
    );
    unsafe { OwnedFd::from_raw_fd(fd) }
}

fn dir(path: &Path) -> OwnedFd {
    open(path, libc::O_PATH | libc::O_DIRECTORY)
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

struct World {
    root: PathBuf,
    home: PathBuf,
    config: PathBuf,
    plugins: PathBuf,
    plugin: PathBuf,
    data_root: PathBuf,
    data: PathBuf,
    canary: Child,
}

impl World {
    fn new(name: &str) -> World {
        let base = std::env::var_os("JAIL_TEST_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/var/tmp"));
        let root = base.join(format!("ri{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let config = home.join(".config/ardia");
        let plugins = config.join("plugins");
        let plugin = plugins.join("sdk-bench");
        let data_root = home.join(".local/share/ardia-data");
        let data = data_root.join("PluginData/sdk-bench");
        copy_tree(&fixture(), &plugin);
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(home.join("secret.txt"), "home secret").unwrap();
        std::fs::create_dir_all(data_root.join("PluginData/other")).unwrap();
        std::fs::write(data_root.join("PluginData/other/secret.txt"), "other").unwrap();
        std::fs::create_dir_all(root.join("victim")).unwrap();
        std::fs::write(root.join("victim/file.txt"), "victim contents").unwrap();
        let canary = Command::new("sleep").arg("600").spawn().unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let context = [
            ("PROBE_PLUGIN_DIR", s(&plugin)),
            ("PROBE_DATA_DIR", s(&data)),
            ("PROBE_HOME", s(&home)),
            ("PROBE_REAL_HOME", std::env::var("HOME").unwrap_or_default()),
            ("PROBE_HOME_SECRET", s(&home.join("secret.txt"))),
            (
                "PROBE_OTHER_DATA_SECRET",
                s(&data_root.join("PluginData/other/secret.txt")),
            ),
            ("PROBE_CONTROL_SOCKET", s(&data_root.join("control.sock"))),
            (
                "PROBE_DBUS_SOCKET",
                "/run/dbus/system_bus_socket".to_string(),
            ),
            ("PROBE_ABSTRACT_SOCKET", "ardia-it-x11".to_string()),
            ("PROBE_CANARY_PID", canary.id().to_string()),
            ("PROBE_BROWSER_PID", std::process::id().to_string()),
            ("PROBE_VICTIM_DIR", s(&root.join("victim"))),
            ("PROBE_VICTIM_FILE", s(&root.join("victim/file.txt"))),
        ]
        .iter()
        .map(|(k, v)| format!("{k}={v}\n"))
        .collect::<String>();
        std::fs::write(plugin.join("probe-context"), context).unwrap();
        World {
            root,
            home,
            config,
            plugins,
            plugin,
            data_root,
            data,
            canary,
        }
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = self.canary.kill();
        let _ = self.canary.wait();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Channel {
    fd: OwnedFd,
    pending: Vec<u8>,
}

impl Channel {
    fn line(&mut self, deadline: Instant) -> Option<String> {
        loop {
            if let Some(at) = self.pending.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=at).collect();
                return Some(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned());
            }
            if !jail::sys::wait_readable(self.fd.as_raw_fd(), deadline).unwrap_or(false) {
                return None;
            }
            let mut chunk = [0u8; 65536];
            match jail::sys::read_some(self.fd.as_raw_fd(), &mut chunk) {
                Ok(0) | Err(_) => return None,
                Ok(count) => self.pending.extend_from_slice(&chunk[..count]),
            }
        }
    }

    fn send(&mut self, message: &Value) {
        let mut line = serde_json::to_vec(message).unwrap();
        line.push(b'\n');
        jail::sys::write_all(self.fd.as_raw_fd(), &line).unwrap();
    }

    fn request(&mut self, method: &str) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let line = self
                .line(deadline)
                .unwrap_or_else(|| panic!("no {method} request arrived"));
            let message: Value = serde_json::from_str(&line).unwrap_or(Value::String(line));
            if message.get("method").and_then(Value::as_str) == Some(method) {
                return message;
            }
            if let Some(id) = message.get("id") {
                self.send(&json!({ "id": id.clone(), "result": Value::Null }));
            }
        }
    }

    fn reply(&mut self, request: &Value, result: Value) {
        self.send(&json!({ "id": request["id"].clone(), "result": result }));
    }

    fn render(&mut self, surface: &str) -> Value {
        loop {
            let render = self.request("surface.render");
            self.reply(&render, Value::Null);
            if render["params"]["surfaceId"] == surface {
                return render;
            }
        }
    }
}

fn count_nodes(value: &Value) -> usize {
    match value {
        Value::Object(map) => {
            usize::from(map.contains_key("type") && map.contains_key("props"))
                + map.values().map(count_nodes).sum::<usize>()
        }
        Value::Array(items) => items.iter().map(count_nodes).sum(),
        _ => 0,
    }
}

fn find_handler(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let (1, Some(Value::String(id))) = (map.len(), map.get("__handler")) {
                return Some(id.clone());
            }
            map.values().find_map(find_handler)
        }
        Value::Array(items) => items.iter().find_map(find_handler),
        _ => None,
    }
}

fn status_field(pid: i32, name: &str) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .unwrap_or_default()
        .lines()
        .find(|line| line.starts_with(name))
        .map(|line| line[name.len()..].trim().to_string())
        .unwrap_or_default()
}

fn run_sdk_bench(level: &str) {
    let world = World::new(level);
    let launcher_fd = open(&launcher(), libc::O_RDONLY);
    let static_launcher = jail::elf::needs_no_loader(launcher_fd.as_raw_fd()).unwrap();
    let bwrap = pinned_bwrap();
    let mut config = SupervisorConfig::new(launcher_fd, bwrap);
    config.require_static_launcher = static_launcher;
    config.allow_full = level == "full";
    config.plugin_parents = vec![dir(&world.plugins)];
    config.forbidden = vec![dir(&world.home), dir(&world.config), dir(&world.data_root)];
    let mut supervisor = Supervisor::new(config).expect("supervisor");
    let caps = supervisor.capabilities().clone();
    let test = format!("real_host/{level}");
    let Ok(_abi) = caps.landlock_abi else {
        skip_or_fail(&test, "this kernel has no Landlock".into());
        return;
    };
    if level == "full" && caps.full_isolation.is_err() {
        skip_or_fail(
            &test,
            format!("full isolation is unavailable: {:?}", caps.full_isolation),
        );
        return;
    }
    let mut pair = [0; 2];
    assert_eq!(
        unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_STREAM | libc::SOCK_CLOEXEC,
                0,
                pair.as_mut_ptr(),
            )
        },
        0
    );
    let (ours, theirs) = unsafe { (OwnedFd::from_raw_fd(pair[0]), OwnedFd::from_raw_fd(pair[1])) };
    let started = Instant::now();
    let launched = supervisor
        .spawn(
            SpawnRequest {
                work: Work::Host {
                    args: vec!["--entry".into(), "dist/index.js".into()],
                },
                plugin_name: "sdk-bench".into(),
                plugin_dir: dir(&world.plugin),
                data_dir: dir(&world.data),
                channel: theirs,
                env: Vec::new(),
                memory_mb: 128,
            },
            &mut Quiet,
        )
        .unwrap_or_else(|error| panic!("{test}: {error}"));
    let expected = if level == "full" {
        Level::Full
    } else {
        Level::HostReduced
    };
    assert_eq!(launched.level, expected);
    let main = launched.main_pid.expect("the host's pid");
    let log_fd = launched.log;
    let drainer = std::thread::spawn(move || {
        let mut data = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(count) = jail::sys::read_some(log_fd.as_raw_fd(), &mut chunk) {
            if count == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..count]);
        }
        String::from_utf8_lossy(&data).into_owned()
    });
    let mut channel = Channel {
        fd: ours,
        pending: Vec::new(),
    };

    let hello = channel.request("hello");
    let cold_start = started.elapsed();
    let seccomp_filters = status_field(main, "Seccomp_filters:");
    let no_new_privs = status_field(main, "NoNewPrivs:");
    let threads = status_field(main, "Threads:");
    channel.reply(&hello, json!({ "app": "Ardia", "version": "test", "protocol": 2, "plugin": "sdk-bench", "values": {} }));
    let activated = channel.request("storage.set");
    assert_eq!(activated["params"]["key"], "activated");
    channel.reply(&activated, Value::Null);
    let ready = channel.request("ready");
    assert_eq!(ready["params"]["commands"], json!(["ping", "spin"]));
    channel.reply(&ready, Value::Null);

    channel.send(&json!({ "call": "p1", "kind": "command", "name": "ping", "input": 5 }));
    let pong = channel.request("result");
    assert_eq!(
        pong["params"],
        json!({ "call": "p1", "result": { "pong": 5 } })
    );
    channel.reply(&pong, Value::Null);

    let commit_start = Instant::now();
    channel.send(
        &json!({ "surface": "mount", "surfaceId": "cap", "viewId": "cap", "kind": "sidebar" }),
    );
    let cap = channel.render("cap");
    let cap_commit = commit_start.elapsed();
    assert_eq!(count_nodes(&cap["params"]["tree"]), 1 + 39 + 39 * 50);

    channel.send(
        &json!({ "surface": "mount", "surfaceId": "rows", "viewId": "rows", "kind": "sidebar" }),
    );
    let rows = channel.render("rows");
    let handler = find_handler(&rows["params"]["tree"]).expect("the Bump handler");
    let bump_start = Instant::now();
    channel.send(
        &json!({ "surface": "event", "surfaceId": "rows", "handlerId": handler, "args": [] }),
    );
    let updated = channel.render("rows");
    let row_update = bump_start.elapsed();
    let text = updated["params"]["tree"].to_string();
    assert!(text.contains("Row 0 · generation 1") && text.contains("Row 999 · generation 1"));

    let stop_start = Instant::now();
    channel.send(&json!({ "event": "plugin.stopping", "time": 0, "data": {} }));
    let deactivated = channel.request("storage.set");
    let stop_latency = stop_start.elapsed();
    assert_eq!(deactivated["params"]["key"], "deactivated");
    channel.reply(&deactivated, Value::Null);
    drop(channel);

    let ended_fd = supervisor.ended_fd(launched.id).unwrap();
    let ended = jail::sys::wait_readable(ended_fd, Instant::now() + WAIT).unwrap_or(false);
    let exit = supervisor.finish(launched.id).unwrap();
    let log = drainer.join().expect("the log drain thread");
    let results: Vec<&str> = log.lines().filter(|l| l.starts_with("RESULT ")).collect();
    let escaped: Vec<&&str> = results
        .iter()
        .filter(|l| l.split_whitespace().nth(2) == Some("ESCAPED"))
        .collect();
    eprintln!(
        "SUMMARY {test} level={:?} abi={} launcher_static={static_launcher} hello_after_confine=yes cold_start={cold_start:?} cap_commit={cap_commit:?} row_update={row_update:?} stop={stop_latency:?} probes={} denied={} escaped={} Seccomp_filters={seccomp_filters} NoNewPrivs={no_new_privs} Threads={threads} exit={exit:?}",
        launched.level,
        launched.landlock_abi,
        results.len(),
        results.len() - escaped.len(),
        escaped.len()
    );
    for line in log.lines() {
        eprintln!("  {line}");
    }
    assert!(
        ended,
        "{test}: the host didn't exit after its channel closed"
    );
    assert_eq!(exit.status, Some(0), "{test}: {exit:?}\n{log}");
    assert!(exit.tree_gone);
    assert!(
        log.contains("INFO probes inside the real QuickJS host"),
        "{log}"
    );
    assert!(log.lines().any(|l| l.starts_with("DONE ")), "{log}");
    let names: Vec<&str> = results
        .iter()
        .filter_map(|line| line.split_whitespace().nth(1))
        .collect();
    let mut sorted_names = names.clone();
    sorted_names.sort_unstable();
    let mut expected: Vec<&str> = HOST_PROBES.to_vec();
    expected.sort_unstable();
    assert_eq!(
        sorted_names, expected,
        "{test}: the probe report isn't complete\n{log}"
    );
    let done = format!("DONE denied={} escaped=0", HOST_PROBES.len());
    assert!(
        log.lines().any(|l| l == done),
        "{test}: expected {done}\n{log}"
    );
    assert!(escaped.is_empty(), "{test}: escaped {escaped:?}");
    assert_eq!(no_new_privs, "1");
    assert!(
        seccomp_filters.parse::<u32>().unwrap_or(0) >= 2,
        "Seccomp_filters={seccomp_filters}"
    );
    assert_eq!(
        std::fs::read_to_string(world.root.join("victim/file.txt")).unwrap(),
        "victim contents"
    );
    assert!(jail::procscan::is_running(world.canary.id() as i32));
}

#[test]
fn the_real_quickjs_host_runs_sdk_bench_at_full_isolation() {
    run_sdk_bench("full");
}

#[test]
fn the_real_quickjs_host_runs_sdk_bench_host_reduced() {
    run_sdk_bench("reduced");
}
