#[allow(dead_code)]
#[path = "../../jail/src/bin/jail-harness/probes.rs"]
mod probes;

use ardia_plugin_host::{ConfinePoint, Exit, Sandbox};

struct JailConfinement {
    probe: Option<probes::Context>,
}

impl Sandbox for JailConfinement {
    fn confine(&mut self, point: &ConfinePoint<'_>) -> Result<(), String> {
        jail::confine_host(point.kept_fds)?;
        if let Some(context) = self.probe.as_mut() {
            context.allowed_fds = point
                .kept_fds
                .iter()
                .copied()
                .filter(|fd| *fd > 3)
                .collect();
            let mut report = probes::Report::new(2);
            report.line(&format!(
                "INFO probes inside the real QuickJS host after confine_host, {} host threads",
                point.threads
            ));
            probes::run_all(&mut report, context);
            report.finish();
        }
        Ok(())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let exit = match args.get(1).map(String::as_str) {
        Some("exec") => match jail::exec_main(&args[2..]) {
            jail::ExecOutcome::Exit(code) => std::process::exit(code),
            jail::ExecOutcome::Host(handoff) => {
                let probe = std::fs::read_to_string("probe-context")
                    .ok()
                    .map(|text| probes::Context::from_text(&text, handoff.level.name(), "host"));
                let mut sandbox = JailConfinement { probe };
                ardia_plugin_host::run_host(&handoff.args, &mut sandbox)
            }
        },
        _ => {
            eprintln!("usage: ardia-plugins exec --policy-fd N --ready-fd N");
            Exit::Usage
        }
    };
    ardia_plugin_host::host::hard_exit(exit, "")
}
