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
export const SYNC_PAUSED_REFUSAL = "Sync is paused. Resume it, or stop syncing, first.";
export const CHAIN_MISSING = "Ardia can’t find its sync data in the sync folder, so Sync is still paused.";
export const QUIT_DURING_RESUME = "Ardia quit before Sync finished resuming.";
const FOLDER_UNREACHABLE = "Sync couldn’t reach the sync folder, so it’s still paused.";
const CLEAR_UNSAVED = "Ardia couldn’t save that Sync has resumed, so it’s still paused. Try Resume again.";

export const UNSETTLED_STARTS_LIMIT = 2;
export const SETTLED_AFTER_MS = 120_000;

export const pausedByGuard = (doc: SyncDoc) => doc.enabled && !!doc.pausedByGuard;

export function pauseAfterUnsettledStarts(doc: SyncDoc, consent: ConsentToken | null) {
  if (!doc.enabled || doc.pausedByGuard || (doc.unsettledStarts ?? 0) < UNSETTLED_STARTS_LIMIT) return false;
  doc.pausedByGuard = true;
  noteSyncPause("sync_paused_after_unsettled_starts", consent);
  return true;
}

export function unsettledStarts({ doc, persist }: { doc: () => SyncDoc; persist: () => Promise<void> }) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function settle(consent: ConsentToken | null) {
    clearTimeout(timer);
    const current = doc();
    if (pausedByGuard(current) || !current.unsettledStarts) return;
    current.unsettledStarts = 0;
    await persist().catch((error: unknown) => warnFor(consent, "[sync] couldn't save that this start settled", error));
  }

  async function countLoad(consent: ConsentToken | null) {
    const current = doc();
    current.unsettledStarts = (current.unsettledStarts ?? 0) + 1;
    await persist().catch((error: unknown) => warnFor(consent, "[sync] couldn't count this start", error));
    clearTimeout(timer);
    timer = setTimeout(() => void settle(consent), SETTLED_AFTER_MS);
  }

  return { countLoad, settle, stop: () => clearTimeout(timer) };
}

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
  countLoad: (consent: ConsentToken | null) => Promise<void>;
  cycle: () => Promise<Partial<SyncUi> | null>;
  persist: () => Promise<void>;
  publish: (patch?: Partial<SyncUi>) => void;
  quitting: () => boolean;
  settlePaused: (error: string | null) => void;
  carryOn: () => void;
};

export function guardResume(steps: ResumeSteps) {
  let running: Promise<void> | null = null;
  let waitingForPhrase: { consent: ConsentToken | null } | null = null;

  async function resume(consent: ConsentToken | null, pressed: boolean) {
    const deviceId = steps.doc().deviceId;
    if (!pausedByGuard(steps.doc()) || !deviceId) return;
    if (pressed) noteSyncPause("sync_resumes", consent);
    steps.publish({ status: "resuming", error: null });
    try {
      if (!(await steps.unlock(deviceId))) {
        waitingForPhrase = { consent };
        return steps.publish({ status: "locked", error: SYNC_LOCKED });
      }
      waitingForPhrase = null;
      if (steps.quitting()) return steps.settlePaused(QUIT_DURING_RESUME);
      await steps.countLoad(consent);
      await steps.load();
      const outcome = await steps.cycle();
      if (outcome?.status !== "updated") return steps.settlePaused(outcome?.error ?? (steps.quitting() ? QUIT_DURING_RESUME : FOLDER_UNREACHABLE));
      const doc = steps.doc();
      delete doc.pausedByGuard;
      try {
        await steps.persist();
      } catch (error) {
        doc.pausedByGuard = true;
        warnFor(consent, "[sync] couldn't save the resumed state", error);
        return steps.settlePaused(CLEAR_UNSAVED);
      }
      steps.publish(outcome);
      noteSyncPause("sync_resumes_completed", consent);
      steps.carryOn();
    } catch (error) {
      warnFor(consent, "[sync] resuming failed", error);
      steps.settlePaused(errorText(error));
    }
  }

  function start(consent: ConsentToken | null, pressed: boolean) {
    running ??= resume(consent, pressed).finally(() => (running = null));
    return running;
  }

  return {
    resumeSync: () => start(consentToken(), true),
    continueAfterPhrase: () => start(waitingForPhrase?.consent ?? null, false),
    running: () => running,
  };
}
