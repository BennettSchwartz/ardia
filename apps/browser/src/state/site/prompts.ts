import type { BlockedPopup, VerificationCodeSetup } from "../../platform/tabs";
import { setUpVerificationCode } from "../../platform/passwords";
import { webviews } from "../../platform/webviews";
import { getSiteSettings, resolveExternalApp } from "./siteSettings";
import { patchPage, pageOf, setPopover, type AutofillPrompt, type PasswordPrompt } from "../tabs/pageState";
import type { ExternalAppRequest } from "../../platform/siteSettings";
import { currentEngineProfile, currentSettings, currentTab } from "../browser/current";
import { noteExternalApp } from "../telemetry/externalAppCounts";
import { noteExternalAppRequest } from "../telemetry/track";
import { showToast } from "../app/toasts";
import { effectivePasswordManager, profilePasswordManager } from "./passwordManager";
import { useBrowser } from "../browser/store";
import { parseVerificationCodeSetup } from "./verificationCodes";
import { noteVerificationCodeSetup } from "../telemetry/passwordManagerCounts";
import { consentToken } from "../telemetry/client";

async function shouldPromptForPopups(profile: string, origin: string): Promise<boolean> {
  try {
    const settings = await getSiteSettings(profile, origin);
    return settings.popups.isDefault;
  } catch {
    return true;
  }
}

export function popupBlocked(tabId: string, popup: BlockedPopup) {
  const first = !pageOf(tabId).popups.length;
  patchPage(tabId, { popups: [...pageOf(tabId).popups, popup] });
  const tab = currentTab(tabId);
  if (first && tab) void shouldPromptForPopups(currentEngineProfile(tab.profileId), popup.origin).then((ask) => ask && setPopover(tabId, "popups"));
}

const passwordManager = (tabId: string) => {
  const s = useBrowser.getState();
  const tab = s.tabs[tabId];
  return tab ? profilePasswordManager(s, tab.profileId) : effectivePasswordManager(currentSettings());
};

export function showPasswordPrompt(tabId: string, prompt: PasswordPrompt) {
  if (prompt.state !== "saved" && passwordManager(tabId) !== "ardia") {
    void webviews.get(tabId)?.resolvePasswordPrompt(prompt.state === "update" ? "nope" : "dismiss");
    return patchPage(tabId, { passwordPrompt: null });
  }
  patchPage(tabId, { passwordPrompt: prompt.state === "saved" ? null : prompt });
}

export function showAutofillPrompt(tabId: string, prompt: AutofillPrompt | null, id: number) {
  if (prompt) patchPage(tabId, { autofillPrompt: prompt });
  else if (pageOf(tabId).autofillPrompt?.id === id) patchPage(tabId, { autofillPrompt: null });
}

export function showVerificationCodePrompt(tabId: string, data: VerificationCodeSetup) {
  const { url, origin } = (data ?? {}) as { url?: unknown; origin?: unknown };
  if (typeof url !== "string" || passwordManager(tabId) !== "apple") return;
  const offered = pageOf(tabId).verificationCodesOffered;
  if (offered.includes(url)) return;
  const setup = parseVerificationCodeSetup(url);
  if (!setup) return;
  patchPage(tabId, { verificationCode: { ...setup, url, origin: typeof origin === "string" ? origin : "" }, verificationCodesOffered: [...offered, url] });
  noteVerificationCodeSetup("offered");
}

export function acceptVerificationCodePrompt(tabId: string, url: string) {
  patchPage(tabId, { verificationCode: null });
  const consent = consentToken();
  noteVerificationCodeSetup("setUp", consent);
  void setUpVerificationCode(url)
    .catch(() => false)
    .then((opened) => {
      if (!opened) noteVerificationCodeSetup("failed", consent);
      const windowId = currentTab(tabId)?.windowId;
      if (!opened && windowId) showToast(windowId, "Couldn't open Passwords.", undefined, { icon: "key.fill" });
    });
}

export function showExternalApp(tabId: string, request: ExternalAppRequest) {
  noteExternalAppRequest(!!request.app);
  if (request.app) patchPage(tabId, { externalApp: request });
  else void resolveExternalApp(request.id, false);
}

export function answerExternalApp(tabId: string, open: boolean, remember = false) {
  const request = pageOf(tabId).externalApp;
  if (!request) return;
  patchPage(tabId, { externalApp: null });
  if (request.app) noteExternalApp(!open ? "declined" : remember ? "allowedAlways" : "allowed");
  void resolveExternalApp(request.id, open, remember);
}
