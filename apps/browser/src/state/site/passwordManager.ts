import { getPasswordAutofill, iCloudPasswordsExtensionSupported, setApplePasswords, setPasswordAutofill } from "../../platform/passwords";
import type { InstalledExtension } from "../../platform/extensions";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile } from "../browser/model";
import type { PasswordManager } from "../settings/settings";
import { effectivePasswordManager, profilePasswordManager, profilesSharingData, regularProfileId, sharedPasswordManagerChoice } from "./passwordManagerChoice";
import { readDocument, saveDocument } from "../../platform/documents";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteApplePasswordsRecordFailed } from "../telemetry/passwordManagerCounts";
import { useExtensions } from "../extensions/store";
import { usePages } from "../tabs/pageState";
import { resource, store as storeResource } from "../settings/resources";

export { effectivePasswordManager, profilePasswordManager, profilesSharingData };

export const useProfilePasswordManager = (profileId: string): PasswordManager => useBrowser((s) => profilePasswordManager(s, profileId));

export function useProfilesSharingChoice(profileId: string): string[] {
  const names = useBrowser((s) =>
    profilesSharingData(s, profileId)
      .filter((id) => id !== profileId)
      .map((id) => s.profiles[id]!.name)
      .join("\n"),
  );
  return names ? names.split("\n") : [];
}

export function choosePasswordManager(profileId: string, manager: PasswordManager) {
  const s = useBrowser.getState();
  for (const id of profilesSharingData(s, profileId)) s.updateProfile(id, { passwordManager: manager });
}

export const ICLOUD_PASSWORDS_EXTENSION_ID = "pejdijmoenmkgeppbflobdenhhabjlaj";
const ICLOUD_PASSWORDS_EXTENSION_IDS = [ICLOUD_PASSWORDS_EXTENSION_ID, "mfbcdcnpokpoajjciilocoachedjkima"];

export const iCloudPasswordsExtensionOf = (list: readonly InstalledExtension[] | undefined) => list?.find((x) => ICLOUD_PASSWORDS_EXTENSION_IDS.includes(x.id));

export const iCloudPasswordsExtensionOn = (list: readonly InstalledExtension[] | undefined) => !!iCloudPasswordsExtensionOf(list)?.enabled;

export const passwordAutofill = resource("passwordAutofill", (profile: string) => getPasswordAutofill(profile).catch(() => true));

const browser = () => useBrowser.getState();

function engineModes(s: BrowserState): Map<string, PasswordManager> {
  const modes = new Map<string, PasswordManager>();
  for (const id of Object.keys(s.profiles)) modes.set(engineProfile(s, id), profilePasswordManager(s, id));
  return modes;
}

function shownEngineProfiles(s: BrowserState): Set<string> {
  const shown = new Set<string>();
  for (const w of Object.values(s.windows)) if (w) shown.add(engineProfile(s, regularProfileId(w.profileId)));
  return shown;
}

const HELD_OFF_DOCUMENT = "password-manager.json";

function heldOffProfiles(): Set<string> {
  try {
    const saved = JSON.parse(readDocument(HELD_OFF_DOCUMENT) ?? "{}") as { offerToSaveHeldOff?: unknown };
    return new Set(Array.isArray(saved.offerToSaveHeldOff) ? saved.offerToSaveHeldOff.filter((p): p is string => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

let recording: Promise<unknown> = Promise.resolve();

function recordHeldOff(profile: string, held: boolean): Promise<boolean> {
  const saved = recording.then(async () => {
    const profiles = heldOffProfiles();
    if (profiles.has(profile) === held) return true;
    if (held) profiles.add(profile);
    else profiles.delete(profile);
    const contents = JSON.stringify({ offerToSaveHeldOff: [...profiles].sort() });
    await saveDocument(HELD_OFF_DOCUMENT, contents);
    return readDocument(HELD_OFF_DOCUMENT) === contents;
  });
  const landed = saved.catch(() => false);
  recording = landed;
  return landed;
}

const clearHeldOff = (profile: string, consent: ConsentToken | null) =>
  recordHeldOff(profile, false).then((landed) => {
    if (!landed) noteApplePasswordsRecordFailed(consent);
  });

type PendingWrite = { on: boolean; sending: boolean; consent: ConsentToken | null };
const pending = new Map<string, PendingWrite>();

async function sendOfferToSave(profile: string, write: PendingWrite) {
  if (!write.on && (await getPasswordAutofill(profile))) {
    if (pending.get(profile) !== write) return;
    if (!(await recordHeldOff(profile, true))) {
      if (pending.get(profile) === write) pending.delete(profile);
      noteApplePasswordsRecordFailed(write.consent);
      return;
    }
  }
  if (pending.get(profile) !== write) return;
  await setPasswordAutofill(write.on, profile);
  if (pending.get(profile) !== write) return;
  pending.delete(profile);
  if (write.on) void clearHeldOff(profile, write.consent);
  storeResource(passwordAutofill, [profile], write.on);
}

function writeOfferToSave(profile: string) {
  const write = pending.get(profile);
  if (!write || write.sending) return;
  write.sending = true;
  void sendOfferToSave(profile, write).then(
    () => void (write.sending = false),
    () => void (write.sending = false),
  );
}

function offerToSave(profile: string, on: boolean) {
  pending.set(profile, { on, sending: false, consent: consentToken() });
  writeOfferToSave(profile);
}

function followMode(profile: string, mode: PasswordManager) {
  if (mode !== "ardia") return offerToSave(profile, false);
  if (heldOffProfiles().has(profile)) return offerToSave(profile, true);
  pending.delete(profile);
}

export function forgetPendingOfferToSave(profile: string, consent: ConsentToken | null): Promise<void> {
  pending.delete(profile);
  return clearHeldOff(profile, consent);
}

function unifySharedChoices() {
  const s = browser();
  const grouped = new Set<string>();
  for (const id of Object.keys(s.profiles)) {
    if (grouped.has(id)) continue;
    const sharing = profilesSharingData(s, id);
    for (const member of sharing) grouped.add(member);
    const choice = sharedPasswordManagerChoice(s, id);
    if (!choice) continue;
    for (const member of sharing) if (s.profiles[member]?.passwordManager !== choice) s.updateProfile(member, { passwordManager: choice });
  }
}

let started = false;

export function startPasswordManager() {
  if (started || !PLATFORM_FEATURES.applePasswords) return;
  started = true;
  let modes = new Map<string, PasswordManager>();
  let appleProfiles = "";
  let handledByExtension: string[] = [];
  let seen = new Set<string>();
  let unifying = false;

  const pushApple = () => {
    const apple = [...modes].filter(([, mode]) => mode === "apple").map(([profile]) => profile).sort();
    const key = JSON.stringify([apple, handledByExtension]);
    if (key === appleProfiles) return;
    appleProfiles = key;
    void setApplePasswords(apple, handledByExtension).catch(() => {});
  };

  const syncModes = () => {
    const next = engineModes(browser());
    for (const [profile, mode] of next) {
      const was = modes.get(profile);
      if (was !== mode) followMode(profile, mode);
    }
    modes = next;
    pushApple();
  };

  const syncWindows = () => {
    const shown = shownEngineProfiles(browser());
    for (const profile of shown) if (!seen.has(profile)) writeOfferToSave(profile);
    seen = shown;
  };

  const syncReady = () => {
    if (!pending.size) return;
    const s = browser();
    for (const tabId of Object.keys(usePages.getState().ready)) {
      const tab = s.tabs[tabId];
      if (tab) writeOfferToSave(engineProfile(s, regularProfileId(tab.profileId)));
    }
  };

  const syncExtensions = async () => {
    if (!(await iCloudPasswordsExtensionSupported())) return;
    const lists = useExtensions.getState().lists;
    handledByExtension = Object.keys(lists)
      .filter((profile) => iCloudPasswordsExtensionOn(lists[profile]))
      .sort();
    pushApple();
  };

  const syncProfiles = () => {
    if (unifying) return;
    unifying = true;
    try {
      unifySharedChoices();
    } finally {
      unifying = false;
    }
    syncModes();
  };

  syncProfiles();
  syncWindows();
  syncReady();
  void syncExtensions();
  useExtensions.subscribe((s, prev) => s.lists !== prev.lists && void syncExtensions());
  usePages.subscribe((s, prev) => s.ready !== prev.ready && syncReady());
  useBrowser.subscribe((s, prev) => {
    if (s.settings !== prev.settings || s.profiles !== prev.profiles) syncProfiles();
    if (s.windows !== prev.windows) syncWindows();
  });
}
