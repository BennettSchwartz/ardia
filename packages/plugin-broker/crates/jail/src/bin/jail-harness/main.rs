mod broker_sim;
mod probes;

use std::time::Duration;

fn write_fd(fd: i32, text: &str) {
    let data = format!("{text}\n");
    unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
}

fn host_sim(handoff: jail::HostHandoff) -> i32 {
    let entry = std::fs::read_to_string("main.js");
    let context_text = std::fs::read_to_string("probe-context").unwrap_or_default();
    let context = probes::Context::from_text(&context_text, handoff.level.name(), "host");
    let mode = match context.get("JAIL_HOST_MODE") {
        mode if mode.is_empty() => "probe".to_string(),
        mode => mode,
    };
    let (thread_tx, thread_rx) = std::sync::mpsc::channel::<i32>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let _ = go_rx.recv();
        let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
        let _ = thread_tx.send(fd);
    });
    if let Err(problem) = jail::confine_host(&[0, 1, 2, 3]) {
        write_fd(2, &format!("confine failed: {problem}"));
        return 76;
    }
    match mode.as_str() {
        "idle" => {
            write_fd(3, "READY");
            let mut buffer = [0u8; 64];
            loop {
                let count = unsafe { libc::read(3, buffer.as_mut_ptr().cast(), buffer.len()) };
                if count <= 0 {
                    return 0;
                }
            }
        }
        _ => {
            let mut report = probes::Report::new(3);
            report.line(&format!(
                "INFO host level={} abi={} trusted-init-read-entry={}",
                handoff.level.name(),
                handoff.landlock_abi,
                entry
                    .as_ref()
                    .map(|text| text.len().to_string())
                    .unwrap_or_else(|e| e.to_string())
            ));
            let _ = go_tx.send(());
            let thread_fd = thread_rx.recv_timeout(Duration::from_secs(5)).unwrap_or(-2);
            probes::run_all(&mut report, &context);
            let escaped = thread_fd >= 0;
            report.line(&format!(
                "RESULT other-thread-socket {} fd={thread_fd}",
                if escaped { "ESCAPED" } else { "denied" }
            ));
            let mut final_report = report;
            if escaped {
                final_report.escaped += 1;
            } else {
                final_report.denied += 1;
            }
            final_report.finish();
            0
        }
    }
}

fn sidecar(mode: &str) -> i32 {
    match mode {
        "escape" => {
            let mut report = probes::Report::new(3);
            let context = probes::Context::from_env("full", "sidecar", true);
            probes::run_all(&mut report, &context);
            report.finish();
            0
        }
        "marker" => {
            let plugin = std::env::var("PROBE_PLUGIN_DIR").unwrap_or_default();
            let mounted =
                std::fs::read_to_string("marker").unwrap_or_else(|e| format!("unreadable {e}"));
            let by_old_path = std::fs::read_to_string(format!("{plugin}/marker"))
                .unwrap_or_else(|e| format!("unreadable {e}"));
            write_fd(
                3,
                &format!("MARKER cwd={} path={}", mounted.trim(), by_old_path.trim()),
            );
            write_fd(3, "DONE");
            0
        }
        "grandchild" | "grandchild-exit" => {
            let first = unsafe { libc::fork() };
            if first == 0 {
                unsafe { libc::setsid() };
                let second = unsafe { libc::fork() };
                if second == 0 {
                    unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
                    unsafe { libc::signal(libc::SIGHUP, libc::SIG_IGN) };
                    write_fd(3, "GRANDCHILD up");
                    loop {
                        unsafe { libc::pause() };
                    }
                }
                unsafe { libc::_exit(0) };
            }
            let mut status = 0;
            unsafe { libc::waitpid(first, &mut status, 0) };
            std::thread::sleep(Duration::from_millis(150));
            write_fd(3, "READY");
            if mode == "grandchild-exit" {
                std::thread::sleep(Duration::from_millis(300));
                return 0;
            }
            loop {
                unsafe { libc::pause() };
            }
        }
        _ => 64,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = match args.get(1).map(String::as_str) {
        Some("exec") => match jail::exec_main(&args[2..]) {
            jail::ExecOutcome::Host(handoff) => host_sim(handoff),
            jail::ExecOutcome::Exit(code) => code,
        },
        Some("probe") => sidecar(args.get(2).map(String::as_str).unwrap_or("")),
        Some("control") => {
            let mut report = probes::Report::new(1);
            let kind = args.get(2).cloned().unwrap_or_else(|| "sidecar".into());
            probes::run_all(
                &mut report,
                &probes::Context::from_env("none", &kind, false),
            );
            report.finish();
            0
        }
        Some("broker-sim") => broker_sim::main(&args[2..]),
        _ => {
            eprintln!("usage: jail-harness exec|probe|control|broker-sim ...");
            64
        }
    };
    std::process::exit(code)
}
