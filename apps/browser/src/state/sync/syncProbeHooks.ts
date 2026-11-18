import { readDocument } from "../../platform/documents";
import { isTestInstance, syncProbeStep } from "../../platform/launchConfig";
import { SyncNative } from "../../platform/sync";
import { currentSyncFolder, enterRecoveryPhrase, resumeSync, stopSync, useSync } from "./engine";
import { recoveryWords } from "./recoveryKit";
import { syncControls } from "./syncControls";
import { DOC } from "./syncDoc";
import { SYNC_PAUSED, SYNC_PAUSED_DETAIL } from "./syncPause";

const say = (line: string) => console.info(`[sync] test: ${line}`);

function settingsLine() {
  const ui = useSync.getState();
  if (ui.status !== "paused") return;
  const controls = syncControls(ui);
  say(`settings: ${SYNC_PAUSED} ${SYNC_PAUSED_DETAIL} | offers ${[controls.primary, ...controls.advanced].join(", ")}`);
}

async function wayOut() {
  const deviceId = (JSON.parse(readDocument(DOC) ?? "{}") as { deviceId?: string }).deviceId;
  if (!SyncNative || !deviceId) return say("way out: no device");
  if (!(await SyncNative.unlock(deviceId))) return say("way out: the key didn't unlock");
  const words = await recoveryWords();
  if (!words?.length) return say("way out: the phrase wasn't disclosed");
  const folder = currentSyncFolder();
  await stopSync();
  say(`way out: stopped, status ${useSync.getState().status}`);
  if (!folder) return say("way out: no folder");
  const joined = await enterRecoveryPhrase(folder, words.join(" "));
  say("ok" in joined ? "way out: rejoined" : `way out: couldn't rejoin: ${joined.error}`);
}

export function startSyncProbeHooks() {
  if (!isTestInstance()) return;
  settingsLine();
  useSync.subscribe((s, prev) => {
    if (s.status !== prev.status) settingsLine();
  });
  const step = syncProbeStep();
  if (step === "resume") {
    say("pressing Resume");
    void resumeSync().then(() => say(`Resume ended, status ${useSync.getState().status}`));
  }
  if (step === "wayOut") void wayOut().catch((error: unknown) => say(`way out failed: ${String(error)}`));
}
