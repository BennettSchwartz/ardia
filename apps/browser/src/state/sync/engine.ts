import { emptyScope, EXTENSION_PREFIX, folderTransport, syncScope, SyncNative, visible, type FolderInfo, type PhraseResult } from "../../platform/sync";
import { create } from "zustand";
import { useBrowser } from "../browser/store";
import { engineProfile } from "../browser/model";
import { historyExpired } from "./historyAdapter";
import { settingsToReapply } from "./settingsAdapter";
import { stopWatchingExtensionIntents, watchExtensionIntents } from "./extensions";
import { appAdapters, extensionsOf, forgetScopeAdapters, profileAdapters, typeSynced } from "./scopeAdapters";
import { APP_SCOPE, defaultTypes, emptyDoc, type SyncDoc, type SyncUi } from "./syncDoc";
import { syncFiles } from "./syncFiles";
import { settleThemeAdoption } from "./syncThemes";
import { editClock, startEditClock } from "./editClock";
import { appScopeOf, linkProfiles, readyToPair } from "./profileLinks";
import { summarize } from "./syncSummary";
import { timedCycle } from "./cycleWork";
import { noteSnapshot } from "./snapshotWrites";
import { freezeRemovals, settleRemovals } from "./profileRemoval";
import { profileScope } from "./records";
import { syncEdits } from "./syncEdits";
import { errorText } from "../../lib/errors";
import { isQuitting, saveBeforeQuit } from "../app/quit";
import { onProfilesOpened, profileOpened } from "../profiles/profileLoading";
import { openTabsClosed, recordOpenTabCloses } from "./openTabCloses";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { CHAIN_MISSING, guardResume, pauseAfterRecoveredStart, pauseAfterUnsettledStarts, pausedByGuard, QUIT_DURING_RESUME, SYNC_LOCKED, SYNC_PAUSED_REFUSAL, unsettledStarts } from "./syncPause";

export { onTabsReceived } from "./sentTabs";
export { takeSnapshotWrites } from "./snapshotWrites";
export { takeOpenTabSyncCounts } from "../telemetry/openTabSyncCounts";

const CYCLE_MS = 15_000;
const AFTER_EDIT_MS = 3_000;

export const useSync = create<SyncUi>()(() => ({
  status: SyncNative ? "off" : "unavailable",
  enabled: false,
  paused: false,
  joining: false,
  folder: null,
  types: defaultTypes(),
  profiles: {},
  lastSyncedAt: null,
  error: null,
  pending: 0,
  devices: [],
  remoteTabs: {},
  remoteProfiles: [],
}));

export const currentSyncFolder = () => useSync.getState().folder;

let doc: SyncDoc = emptyDoc();
let cycle: Promise<void> | null = null;
let again = false;
let forcePasswordsNext = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let outcome: Partial<SyncUi> | null = null;
const paused = () => pausedByGuard(doc);
const { read, loadState, persistJournal, watchScope, save, saveDocNow, unload, startOver, checkpoint } = syncFiles(() => doc);
const report = (patch: Partial<SyncUi>) => void (paused() ? (outcome = patch) : publishUi(patch));
const standsDown = () => paused() && isQuitting() && (report({ status: "stalled", error: QUIT_DURING_RESUME }), true);

function load() {
  const loaded = read();
  if (loaded) doc = loaded;
}

function publishUi(patch: Partial<SyncUi> = {}) {
  const live = doc.enabled && !paused();
  useSync.setState({
    enabled: doc.enabled,
    paused: paused(),
    joining: live && doc.joining,
    folder: doc.folder,
    types: { ...doc.types },
    profiles: { ...doc.profiles },
    lastSyncedAt: doc.lastSyncedAt,
    ...(live ? summarize(doc) : { devices: [], remoteTabs: {}, remoteProfiles: [], pending: 0 }),
    ...patch,
  });
}

function watchExtensions() {
  if (!doc.enabled) return;
  const s = useBrowser.getState();
  const watched = Object.entries(doc.profiles).filter(([id, l]) => l.enabled && s.profiles[id] && typeSynced(doc, "extensions", id));
  const profiles = [...new Set(watched.map(([id]) => engineProfile(s, id)))].filter((engine) => profileOpened(engine));
  if (profiles.length) watchExtensionIntents(profiles);
}

function scheduleSync(delay = AFTER_EDIT_MS) {
  if (!doc.enabled || paused()) return;
  clearTimeout(timer);
  timer = setTimeout(() => void runCycle(), delay);
}

export async function syncNow() {
  if (!paused()) await runCycle({ forcePasswords: true });
}

type CycleOptions = { retiring?: boolean; forcePasswords?: boolean };

async function runCycle({ retiring = false, forcePasswords = false }: CycleOptions = {}, resume = false) {
  if (!SyncNative || !doc.enabled || !doc.folder || !doc.deviceId || useSync.getState().status === "locked" || (paused() && !resume)) return;
  if (cycle) {
    again = true;
    forcePasswordsNext ||= forcePasswords;
    return;
  }
  const options = { retiring, forcePasswords: forcePasswords || forcePasswordsNext };
  forcePasswordsNext = false;
  cycle = timedCycle(Date.now(), cycleOnce(SyncNative, doc.folder, doc.deviceId, options));
  try {
    await cycle;
  } finally {
    cycle = null;
  }
}

async function cycleOnce(native: NonNullable<typeof SyncNative>, folder: string, device: string, { retiring, forcePasswords }: Required<CycleOptions>) {
  const consent = consentToken();
  clearTimeout(timer);
  const slow = setTimeout(() => useSync.getState().status === "updated" && publishUi({ status: "updating" }), 1000);
  try {
    watchExtensions();
    const status = await native.chainStatus(folder);
    if (status === "unavailable") return report({ status: "offline", error: null });
    if (status === "missing") return paused() ? report({ status: "stalled", error: CHAIN_MISSING }) : await resetFromElsewhere();
    if (standsDown()) return;
    const transport = folderTransport(native, folder);
    if (editClock().device !== device) startEditClock(device, doc.clock);
    const clock = editClock();
    const app = appScopeOf(doc);
    if (freezeRemovals(doc)) save();
    const appSettled = watchScope(APP_SCOPE, app, clock);
    try {
      noteSnapshot(await syncScope({
        scope: APP_SCOPE,
        state: app,
        transport,
        adapters: appAdapters(doc, retiring),
        clock,
        device,
        options: { persist: persistJournal(APP_SCOPE), holdApply: isQuitting },
      }));
    } finally {
      await appSettled();
    }
    settleRemovals(doc, app);
    if (app.joined && readyToPair(doc, app) && !isQuitting()) linkProfiles(doc, app);
    settleThemeAdoption(doc.profiles, app, true);
    let pending = app.pending;
    const s = useBrowser.getState();
    for (const [profileId, link] of Object.entries(doc.profiles)) {
      if (standsDown()) return;
      const exists = !!s.profiles[profileId];
      const retire = retiring || !!link.retire || !exists;
      if (!retire && !link.enabled) continue;
      const scope = profileScope(link.syncId);
      const state = (doc.scopes[scope] ??= emptyScope());
      const settled = watchScope(scope, state, clock);
      try {
        noteSnapshot(await syncScope({
          scope,
          state,
          transport,
          adapters: profileAdapters(doc, profileId, retire, forcePasswords),
          clock,
          device,
          options: { expired: historyExpired, persist: persistJournal(scope), holdApply: isQuitting },
        }));
      } finally {
        await settled();
      }
      pending += state.pending;
      if (!retire && !isQuitting() && typeSynced(doc, "extensions", profileId) && profileOpened(engineProfile(useBrowser.getState(), profileId))) await extensionsOf(profileId).reconcile(visible(state, EXTENSION_PREFIX), Date.now(), isQuitting);
      if (retire) {
        delete link.retire;
        if (!exists) {
          delete doc.scopes[scope];
          delete doc.sends?.[scope];
          delete doc.profiles[profileId];
        }
      }
    }
    doc.clock = clock.last;
    doc.lastSyncedAt = Date.now();
    report({ status: "updated", error: null, pending });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_SYNC_FOLDER_UNREADABLE") {
      report({ status: "offline", error: "The sync folder can’t be read. Check that it’s still there and that Ardia can open it." });
    } else if (useSync.getState().status !== "locked") {
      warnFor(consent, "[sync] cycle failed", error);
      report({ status: "stalled", error: errorText(error) });
    }
  } finally {
    clearTimeout(slow);
    save();
    if (doc.enabled) {
      scheduleSync(again ? 0 : CYCLE_MS);
      again = false;
    }
  }
}

async function loadSavedState() {
  await loadState();
  startEditClock(doc.deviceId ?? "", doc.clock);
  const app = doc.scopes[APP_SCOPE];
  if (app) app.unapplied = [...new Set([...app.unapplied, ...settingsToReapply(app.records)])];
  settleThemeAdoption(doc.profiles, app, false);
}

async function resetFromElsewhere() {
  await SyncNative?.forget(doc.deviceId!);
  doc = { ...emptyDoc(), folder: doc.folder, types: doc.types };
  startOver();
  publishUi({ status: "reset", error: "This device is out of sync. Sync may have been reset from another device." });
}

export async function folderInfo(path?: string | null): Promise<FolderInfo | null> {
  return (await SyncNative?.folderInfo(path ?? doc.folder ?? null)) ?? null;
}

function setSyncFolder(path: string) {
  if (doc.enabled) return;
  doc.folder = path;
  save();
  publishUi();
}

export async function chooseSyncFolder(): Promise<string | null> {
  if (paused()) return null;
  const picked = (await SyncNative?.chooseFolder(doc.folder)) ?? null;
  if (picked) setSyncFolder(picked);
  return picked;
}

function begin(folder: string, deviceId: string, joining: boolean) {
  doc = { ...emptyDoc(), types: doc.types, enabled: true, folder, deviceId, setupAt: Date.now(), joining };
  startOver();
  publishUi({ status: "starting", error: null });
  scheduleSync(0);
}

export async function turnOnSync(folder: string): Promise<{ ok: true } | { error: string }> {
  const native = SyncNative;
  if (!native) return { error: "Sync isn’t available in this build." };
  if (paused()) return { error: SYNC_PAUSED_REFUSAL };
  const deviceId = native.newDeviceId();
  try {
    if (!(await native.createPhrase(deviceId))) return { error: `Couldn’t save the sync key in ${PLATFORM_TERMS.secretStore}.` };
    await native.createChain(folder);
  } catch (error) {
    await native.forget(deviceId);
    return { error: `Couldn’t use that folder: ${errorText(error)}` };
  }
  begin(folder, deviceId, false);
  return { ok: true };
}

export async function enterRecoveryPhrase(folder: string, text: string): Promise<PhraseResult | { error: "unavailable" }> {
  const native = SyncNative;
  if (!native) return { error: "unavailable" };
  if (doc.enabled && doc.deviceId && useSync.getState().status === "locked") {
    const result = await native.enterPhrase(doc.deviceId, text, doc.folder ?? folder);
    if ("ok" in result && paused()) void continueAfterPhrase();
    else if ("ok" in result) {
      await loadSavedState();
      publishUi({ status: "starting", error: null });
      scheduleSync(0);
    }
    return result;
  }
  if (paused()) return { error: "unavailable" };
  const deviceId = native.newDeviceId();
  const result = await native.enterPhrase(deviceId, text, folder);
  if ("ok" in result) begin(folder, deviceId, true);
  return result;
}

export async function stopSync({ deleteData = false } = {}) {
  const native = SyncNative;
  if (!native || !doc.enabled) return;
  const consent = consentToken();
  await running();
  clearTimeout(timer);
  const wasPaused = paused();
  const reportFailure = (error: unknown) => warnFor(consent, "[sync] the last cycle before stopping failed", error);
  while (cycle) await cycle.catch(reportFailure);
  if (!wasPaused && useSync.getState().status !== "locked") await runCycle({ retiring: true }).catch(reportFailure);
  clearTimeout(timer);
  const folder = doc.folder;
  if (deleteData && folder && !wasPaused) {
    try {
      await native.deleteChain(folder);
    } catch (error) {
      warnFor(consent, "[sync] deleting sync data failed", error);
    }
  }
  if (doc.deviceId) await native.forget(doc.deviceId);
  doc = { ...emptyDoc(), folder, types: doc.types };
  forgetScopeAdapters();
  startOver();
  publishUi({ status: "off", error: null });
}

const docChanged = () => void (save(), publishUi(), scheduleSync(0));

export const { adoptProfileTheme, setTypeSynced, setProfileSynced, setOpenTabsSynced, sendTargets, sendTab, addRemoteProfile, removeRemoteProfile, removeSyncedDevice } = syncEdits({
  doc: () => doc,
  refused: paused,
  locked: () => useSync.getState().status === "locked",
  save,
  changed: docChanged,
  schedule: scheduleSync,
  afterEditMs: AFTER_EDIT_MS,
});

export const appScopeRecords = () => doc.scopes[APP_SCOPE]?.records ?? {};

function settlePaused(error: string | null) {
  clearTimeout(timer);
  again = forcePasswordsNext = false;
  stopWatchingExtensionIntents();
  forgetScopeAdapters();
  unload();
  doc = { ...(read() ?? { ...doc, scopes: {} }), pausedByGuard: true };
  publishUi({ status: "paused", error });
}

const starts = unsettledStarts({ doc: () => doc, persist: saveDocNow });
const resumeCycle = async () => ((outcome = null), await runCycle({}, true), outcome);
const { resumeSync, continueAfterPhrase, running } = guardResume({ doc: () => doc, unlock: async (deviceId) => !!(await SyncNative?.unlock(deviceId)), load: loadSavedState, countLoad: starts.countLoad, cycle: resumeCycle, persist: saveDocNow, publish: publishUi, quitting: isQuitting, settlePaused, carryOn: () => scheduleSync(CYCLE_MS) });
export { resumeSync };

export function startSync() {
  const native = SyncNative;
  if (!native) return;
  load();
  const consent = consentToken();
  if (pauseAfterRecoveredStart(doc, consent) || pauseAfterUnsettledStarts(doc, consent)) void saveDocNow().catch((error: unknown) => warnFor(consent, "[sync] couldn't record the pause", error));
  publishUi(paused() ? { status: "paused", error: null } : { status: doc.enabled ? "starting" : "off" });
  if (!paused()) watchExtensions();
  if (doc.enabled && doc.deviceId && !paused()) {
    const deviceId = doc.deviceId;
    void starts
      .countLoad(consent)
      .then(() => native.unlock(deviceId))
      .then(async (ok) => {
        if (!ok) return publishUi({ status: "locked", error: SYNC_LOCKED });
        await loadSavedState();
        publishUi();
        scheduleSync(500);
      })
      .catch((error: unknown) => {
        warnFor(consent, "[sync] unlocking at launch failed", error);
        publishUi({ status: "stalled", error: errorText(error) });
      });
  }
  saveBeforeQuit("sync", async () => {
    starts.stop();
    await running();
    if (paused()) return;
    await starts.settle(consent);
    await checkpoint();
  });
  onProfilesOpened(() => {
    if (!doc.enabled || !doc.deviceId || paused()) return;
    watchExtensions();
    scheduleSync();
  });
  useBrowser.subscribe((s, prev) => {
    if (!doc.enabled) return;
    const closed = !isQuitting() && recordOpenTabCloses(doc, openTabsClosed(s, prev));
    if (closed && !cycle) save();
    if (paused()) return;
    if (closed || (!cycle && (s.bookmarks !== prev.bookmarks || s.settings !== prev.settings || s.profiles !== prev.profiles || s.profileOrder !== prev.profileOrder || s.groups !== prev.groups))) scheduleSync();
  });
  if (__DEV__) {
    (globalThis as { acSync?: object }).acSync = {
      useSync, syncNow, resumeSync, turnOnSync, enterRecoveryPhrase, stopSync, setTypeSynced, setProfileSynced, setOpenTabsSynced, addRemoteProfile, removeRemoteProfile, removeSyncedDevice, setSyncFolder, folderInfo,
      doc: () => doc,
      native: SyncNative,
      get menu(): typeof import("./menu") {
        return require("./menu");
      },
    };
  }
}
