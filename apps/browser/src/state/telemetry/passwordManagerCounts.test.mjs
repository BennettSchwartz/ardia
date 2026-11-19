import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { markTabReady, pageOf } = await import("../tabs/pageState.ts");
const { requestAutofill } = await import("../site/autofill.ts");
const { acceptVerificationCodePrompt, showVerificationCodePrompt } = await import("../site/prompts.ts");
const { noteApplePasswordsPanel, notePasswordManagerChosen, takePasswordManagerCounts } = await import("./passwordManagerCounts.ts");

const S = () => useBrowser.getState();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const SETUP = "otpauth://totp/Example:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";

test("Apple Passwords counts each panel opened from the menu and the key button, each code setup step and each manager picked", async () => {
  stub.passwordManagerEngine.available = true;
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://a.example/login" });
  const tabId = Object.values(S().tabs).find((t) => t?.windowId === windowId).id;
  markTabReady(tabId);
  takePasswordManagerCounts();

  await requestAutofill(windowId, "passwords", tabId);
  assert.deepEqual(stub.appleAutoFillCalls.at(-1), { tabId, kind: "passwords" });
  noteApplePasswordsPanel("key", true);
  noteApplePasswordsPanel("key", false);
  showVerificationCodePrompt(tabId, { url: SETUP, origin: "https://a.example", main: true });
  showVerificationCodePrompt(tabId, { url: SETUP, origin: "https://a.example", main: true });
  assert.equal(pageOf(tabId).verificationCode?.issuer, "Example");
  acceptVerificationCodePrompt(tabId, SETUP);
  await settle();
  notePasswordManagerChosen("ardia");

  const counts = takePasswordManagerCounts();
  assert.equal(counts.apple_passwords_menu_opens, 1);
  assert.equal(counts.apple_passwords_menu_refused, 0);
  assert.equal(counts.apple_passwords_key_opens, 1);
  assert.equal(counts.apple_passwords_key_refused, 1);
  assert.equal(counts.verification_code_setups_offered, 1, "the same setup link is offered once per page");
  assert.equal(counts.verification_code_setups_accepted, 1);
  assert.equal(counts.verification_code_setups_failed, 0);
  assert.equal(counts.password_manager_chose_ardia, 1);
  assert.equal(takePasswordManagerCounts().apple_passwords_menu_opens, 0, "taking the counts clears them");
});
