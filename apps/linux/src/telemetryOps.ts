import { resetAnonymousId } from "../../browser/src/state/telemetry/index.ts";
import { endSession, saveQueueNow, setSharing } from "../../browser/src/state/telemetry/client";
import { dismissAsk } from "../../browser/src/state/telemetry/choice";
import { adoptInstallId } from "../../browser/src/state/telemetry/installId";
import type { ChoiceChange } from "../../browser/src/state/telemetry/relay";
import { reopenSession } from "../../browser/src/state/telemetry/sessionControl";
import { reopenSessionAfterCancelledQuit } from "../../browser/src/state/telemetry/sessionQuit";
import { startWatch, stopWatch, watchNoticeShown } from "../../browser/src/state/telemetry/watch";
import { sessionEnding } from "../../browser/src/state/telemetry/usage";
import { documentSaved } from "../../browser/src/platform/documents";
import type { TelemetryOp } from "./telemetryLeader.ts";
import { createEndLedger } from "./telemetrySettle.ts";
import { parseChoiceChange } from "./telemetryChoice.ts";

const STATE_DOC = "telemetry.json";
const END_TIMEOUT_MS = 2_000;

const report = (error: unknown) => console.warn("[ardia linux] telemetry", error);

let sessionEnded = false;
let announcer: { announce(): void } | null = null;
const ends = createEndLedger();

export const setSessionEnded = (ended: boolean) => void (sessionEnded = ended);
export const setTelemetryAnnouncer = (next: { announce(): void } | null) => void (announcer = next);

export async function saveState() {
  await saveQueueNow(END_TIMEOUT_MS);
  await documentSaved(STATE_DOC).catch(report);
}

function applyChoice(change: ChoiceChange) {
  if (change.kind === "sharing") setSharing(change.on, change.source, change.placement);
  else if (change.kind === "askDismissed") dismissAsk();
  else if (change.kind === "watchStarted") startWatch(change.reportId, change.days);
  else if (change.kind === "watchStopped") stopWatch();
  else if (change.kind === "watchNoticeShown") watchNoticeShown();
  else adoptInstallId(change.id);
}

export async function handleTelemetryOp(op: TelemetryOp, arg?: string): Promise<unknown> {
  if (op === "choice") {
    const change = parseChoiceChange(arg);
    if (!change) throw Object.assign(new Error("The telemetry choice isn't one this build knows"), { code: "ERR_TELEMETRY_CHOICE" });
    applyChoice(change);
    await documentSaved(STATE_DOC);
    announcer?.announce();
    return true;
  }
  if (op === "reset") {
    const installId = await resetAnonymousId();
    await documentSaved(STATE_DOC);
    announcer?.announce();
    return installId;
  }
  if (op === "reopen") {
    if (!ends.reopens(arg)) return false;
    if (!reopenSessionAfterCancelledQuit()) reopenSession();
    sessionEnded = false;
    await documentSaved(STATE_DOC).catch(report);
    return true;
  }
  if (sessionEnded) endSession();
  else sessionEnding();
  sessionEnded = true;
  const token = ends.end();
  await saveState();
  return token;
}
