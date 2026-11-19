import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
PLATFORM_FEATURES.applePasswords = false;
const { useBrowser } = await import("../browser/store.ts");
const { useExtensions } = await import("../extensions/store.ts");
const { ICLOUD_PASSWORDS_EXTENSION_ID, startPasswordManager } = await import("./passwordManager.ts");

const engine = stub.passwordManagerEngine;

test("off the Mac, starting the password manager calls nothing of Apple Passwords and doesn't take a pending probe for support", () => {
  engine.extensionSupported = Promise.resolve(false);
  useExtensions.setState({ lists: { "": [{ id: ICLOUD_PASSWORDS_EXTENSION_ID, name: "iCloud Passwords", enabled: true }] } });
  useBrowser.getState().hydrate({});
  engine.calls.splice(0);
  startPasswordManager();
  assert.deepEqual(engine.calls.filter((c) => c[0] === "applePasswords"), []);
});
