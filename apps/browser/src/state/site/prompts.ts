import type { BlockedPopup } from "../../platform/tabs";
import { getSiteSettings, resolveExternalApp } from "./siteSettings";
import { patchPage, pageOf, setPopover, type AutofillPrompt, type AutofillPromptAnswer, type PasswordPrompt, type PasswordPromptAnswer } from "../tabs/pageState";
import { webviews } from "../tabs/webviewHandles";
import type { ExternalAppRequest } from "../../platform/siteSettings";
import { currentEngineProfile, currentTab } from "../browser/current";
import { noteExternalApp } from "../telemetry/externalAppCounts";
import { noteExternalAppRequest } from "../telemetry/track";

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

export function showPasswordPrompt(tabId: string, prompt: PasswordPrompt) {
  patchPage(tabId, { passwordPrompt: prompt.state === "saved" ? null : prompt });
}

export function showAutofillPrompt(tabId: string, prompt: AutofillPrompt | null, id: number) {
  if (prompt) patchPage(tabId, { autofillPrompt: prompt });
  else if (pageOf(tabId).autofillPrompt?.id === id) patchPage(tabId, { autofillPrompt: null });
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

export function answerPasswordPrompt(tabId: string, action: PasswordPromptAnswer, username?: string) {
  const prompt = pageOf(tabId).passwordPrompt;
  if (!prompt) return false;
  const offer = prompt.offer === undefined ? {} : { offer: prompt.offer };
  const keeps = action === "save" || action === "update";
  void webviews.get(tabId)?.resolvePasswordPrompt(action, keeps ? { username: username ?? prompt.username, ...offer } : prompt.offer === undefined ? undefined : offer);
  patchPage(tabId, { passwordPrompt: null });
  return true;
}

export function answerAutofillPrompt(tabId: string, action: AutofillPromptAnswer) {
  const prompt = pageOf(tabId).autofillPrompt;
  if (!prompt) return false;
  void webviews.get(tabId)?.resolveAutofillPrompt(prompt.id, action);
  patchPage(tabId, { autofillPrompt: null });
  return true;
}
