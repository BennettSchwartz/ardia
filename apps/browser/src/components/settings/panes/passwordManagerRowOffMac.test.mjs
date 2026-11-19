import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../../test-hooks.mjs";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

const native = await import("../../../test-native/ardiacore.ts");
const { PLATFORM_FEATURES } = await import("../../../lib/platformFeatures.ts");
PLATFORM_FEATURES.applePasswords = false;
const { useBrowser } = await import("../../../state/browser/store.ts");
const { PasswordManagerRow } = await import("./ApplePasswordsDetails.tsx");

test("the profile settings off the Mac never ask for Apple Passwords' availability", () => {
  useBrowser.getState().hydrate({});
  native.passwordManagerEngine.probes = 0;
  mount(() => PasswordManagerRow({ profileId: useBrowser.getState().settings.defaultProfileId }));
  assert.equal(native.passwordManagerEngine.probes, 0);
});
