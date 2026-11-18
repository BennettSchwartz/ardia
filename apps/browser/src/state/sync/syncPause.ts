import { recoveredStart } from "../../platform/launchConfig";
import { errorText } from "../../lib/errors";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { noteSyncPause } from "../telemetry/syncPauseCounts";
import type { ConsentToken } from "../telemetry/choice";
import type { SyncDoc, SyncUi } from "./syncDoc";

export const SYNC_PAUSED = "Sync is paused because Ardia didn’t start properly.";
export const SYNC_PAUSED_DETAIL = "Nothing was deleted. Resume loads Sync again.";
export const SYNC_LOCKED = `Enter your recovery phrase to keep syncing on this ${PLATFORM_TERMS.computer}.`;

export const pausedByGuard = (doc: SyncDoc) => doc.enabled && !!doc.pausedByGuard;

export function pauseAfterRecoveredStart(doc: SyncDoc, consent: ConsentToken | null, recovered = recoveredStart()) {
  if (!doc.enabled || !recovered) return false;
  doc.pausedByGuard = true;
  noteSyncPause("sync_paused_by_launch_guard", consent);
  return true;
}

export type ResumeSteps = {
  doc: () => SyncDoc;
  unlock: (deviceId: string) => Promise<boolean>;
  load: () => Promise<void>;
  cycle: () => Promise<void>;
  ui: () => Pick<SyncUi, "status" | "error">;
  publish: (patch?: Partial<SyncUi>) => void;
  save: () => void;
  carryOn: () => void;
};

export function guardResume(steps: ResumeSteps) {
  let resuming = false;
  const stayPaused = (error: string | null) => steps.publish({ status: "paused", error });
  return async function resumeSync(pressed = true) {
    const deviceId = steps.doc().deviceId;
    if (!pausedByGuard(steps.doc()) || !deviceId || resuming) return;
    const consent = consentToken();
    if (pressed) noteSyncPause("sync_resumes", consent);
    resuming = true;
    steps.publish({ status: "starting", error: null });
    try {
      if (!(await steps.unlock(deviceId))) return steps.publish({ status: "locked", error: SYNC_LOCKED });
      await steps.load();
      await steps.cycle();
      const doc = steps.doc();
      if (!pausedByGuard(doc)) return;
      const { status, error } = steps.ui();
      if (status !== "updated") return stayPaused(error ?? "Sync couldn’t reach the sync folder, so it’s still paused.");
      delete doc.pausedByGuard;
      steps.save();
      steps.publish();
      noteSyncPause("sync_resumes_completed", consent);
      steps.carryOn();
    } catch (error) {
      warnFor(consent, "[sync] resuming failed", error);
      stayPaused(errorText(error));
    } finally {
      resuming = false;
    }
  };
}
