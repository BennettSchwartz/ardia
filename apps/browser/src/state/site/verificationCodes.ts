import { hostOf } from "@ardia/core";
import { setUpVerificationCode, type VerificationCodeFound } from "../../platform/passwordProviders";
import { patchPage, pageOf, usePages } from "../tabs/pageState";
import { currentTab } from "../browser/current";
import { showToast } from "../app/toasts";
import { consentToken } from "../telemetry/choice";
import { noteVerificationCodeSetup } from "../telemetry/passwordManagerCounts";

const MAX_APP = 40;
const clipped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export function verificationCodeCopy(app: string, host: string): { title: string; message: string } {
  const name = clipped(app, MAX_APP);
  return {
    title: `Set Up Verification Code in ${name}?`,
    message: `${host ? `${clipped(host, 64)} shows a two-factor setup code. ` : ""}${name} fills its codes from now on.`,
  };
}

const appOf = (found: VerificationCodeFound): string => {
  const app = (found as { app?: unknown } | null)?.app;
  return typeof app === "string" ? app.trim() : "";
};

export function offerVerificationCode(tabId: string, found: VerificationCodeFound, offered: (tabId: string) => boolean, generation: number) {
  const token = typeof found?.token === "string" ? found.token : "";
  const app = appOf(found);
  if (!token || !app || !offered(tabId) || pageOf(tabId).verificationCode) return;
  patchPage(tabId, { verificationCode: { token, app, host: hostOf(currentTab(tabId)?.url ?? "") ?? "", generation } });
  noteVerificationCodeSetup("offered", consentToken());
}

export function declineVerificationCode(tabId: string) {
  patchPage(tabId, { verificationCode: null });
}

export function acceptVerificationCode(tabId: string) {
  const offer = pageOf(tabId).verificationCode;
  if (!offer) return;
  patchPage(tabId, { verificationCode: null });
  const consent = consentToken();
  noteVerificationCodeSetup("accepted", consent);
  void setUpVerificationCode(tabId, offer.token, offer.generation)
    .then((r) => !!r?.opened, () => false)
    .then((opened) => {
      if (opened) return;
      noteVerificationCodeSetup("failed", consent);
      const windowId = currentTab(tabId)?.windowId;
      if (windowId) showToast(windowId, `Couldn't open ${clipped(offer.app, MAX_APP)}.`, undefined, { icon: "key.fill" });
    });
}

export function closeVerificationCodePrompts() {
  for (const [tabId, page] of Object.entries(usePages.getState().pages)) if (page.verificationCode) patchPage(tabId, { verificationCode: null });
}
