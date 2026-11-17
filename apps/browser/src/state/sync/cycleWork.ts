import { consentToken, onConsentPeriodChange, stillValid } from "../telemetry/choice";

const NO_CYCLES = { cycles: 0, ms: 0, longestMs: 0 };
let work = NO_CYCLES;

onConsentPeriodChange(() => (work = NO_CYCLES));

export function timedCycle(startedAt: number, cycle: Promise<void>): Promise<void> {
  const token = consentToken();
  if (token === null) return cycle;
  return cycle.finally(() => {
    if (!stillValid(token)) return;
    const ms = Date.now() - startedAt;
    work = { cycles: work.cycles + 1, ms: work.ms + ms, longestMs: Math.max(work.longestMs, ms) };
  });
}

export function takeCycleWork() {
  const taken = work;
  work = NO_CYCLES;
  return taken;
}
