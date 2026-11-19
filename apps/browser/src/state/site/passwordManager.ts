import { getPasswordAutofill, iCloudPasswordsExtensionSupported, setApplePasswords, setPasswordAutofill } from "../../platform/passwords";
import type { InstalledExtension } from "../../platform/extensions";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { useBrowser, type BrowserState } from "../browser/store";
import { engineProfile } from "../browser/model";
import type { PasswordManager } from "../settings/settings";
import { effectivePasswordManager, profilePasswordManager, regularProfileId } from "./passwordManagerChoice";
import { useExtensions } from "../extensions/store";
import { usePages } from "../tabs/pageState";
import { resource, store as storeResource } from "../settings/resources";

export { effectivePasswordManager, profilePasswordManager };

export const useProfilePasswordManager = (profileId: string): PasswordManager => useBrowser((s) => profilePasswordManager(s, profileId));

export function choosePasswordManager(profileId: string, manager: PasswordManager) {
  useBrowser.getState().updateProfile(regularProfileId(profileId), { passwordManager: manager });
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

type PendingWrite = { on: boolean };
const pending = new Map<string, PendingWrite>();

function writeOfferToSave(profile: string) {
  const write = pending.get(profile);
  if (!write) return;
  void setPasswordAutofill(write.on, profile).then(
    () => {
      if (pending.get(profile) !== write) return;
      pending.delete(profile);
      storeResource(passwordAutofill, [profile], write.on);
    },
    () => {},
  );
}

function offerToSave(profile: string, on: boolean) {
  pending.set(profile, { on });
  writeOfferToSave(profile);
}

export const forgetPendingOfferToSave = (profile: string) => void pending.delete(profile);

let started = false;

export function startPasswordManager() {
  if (started || !PLATFORM_FEATURES.applePasswords) return;
  started = true;
  let modes = new Map<string, PasswordManager>();
  let appleProfiles = "";
  let handledByExtension: string[] = [];
  let seen = new Set<string>();
  const ready = new Set<string>();

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
      if (was === mode) continue;
      if (was !== undefined || mode !== "ardia") offerToSave(profile, mode === "ardia");
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
    const s = browser();
    for (const tabId of Object.keys(usePages.getState().ready)) {
      const tab = s.tabs[tabId];
      const profile = tab && engineProfile(s, regularProfileId(tab.profileId));
      if (profile === undefined || ready.has(profile)) continue;
      ready.add(profile);
      writeOfferToSave(profile);
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

  syncModes();
  syncWindows();
  syncReady();
  void syncExtensions();
  useExtensions.subscribe((s, prev) => s.lists !== prev.lists && void syncExtensions());
  usePages.subscribe((s, prev) => s.ready !== prev.ready && syncReady());
  useBrowser.subscribe((s, prev) => {
    if (s.settings !== prev.settings || s.profiles !== prev.profiles) syncModes();
    if (s.windows !== prev.windows) syncWindows();
  });
}
