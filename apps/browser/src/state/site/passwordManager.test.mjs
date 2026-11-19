import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
const { ICLOUD_PASSWORDS_EXTENSION_ID, choosePasswordManager, effectivePasswordManager, profilePasswordManager, startPasswordManager } = await import("./passwordManager.ts");
const { useExtensions } = await import("../extensions/store.ts");
const { setPasswordAutofillFor } = await import("../settings/paneData.ts");

const engine = stub.passwordManagerEngine;
const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

const calls = (kind) => engine.calls.filter((c) => c[0] === kind).map((c) => c.slice(1));
const takeCalls = () => engine.calls.splice(0);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
let work = "";

test("Apple Passwords falls back to Ardia's manager on a Mac that can't show it, and a profile's own choice wins over the install's", () => {
  engine.available = false;
  assert.equal(effectivePasswordManager({ passwordManager: "apple" }), "ardia");
  assert.equal(effectivePasswordManager(DEFAULT_SETTINGS), "ardia");
  assert.equal(effectivePasswordManager({ passwordManager: "none" }), "none");
  engine.available = true;
  assert.equal(effectivePasswordManager(DEFAULT_SETTINGS), "apple");
  assert.equal(effectivePasswordManager({ passwordManager: "ardia" }), "ardia");
  assert.equal(effectivePasswordManager({ passwordManager: "keychain" }), "apple", "an unknown saved value is the default");
  assert.equal(effectivePasswordManager({ passwordManager: "ardia" }, { passwordManager: "apple" }), "apple");
  assert.equal(effectivePasswordManager({ passwordManager: "apple" }, { passwordManager: "none" }), "none");
  assert.equal(effectivePasswordManager({ passwordManager: "apple" }, {}), "apple", "a profile that never chose follows the install");
});

test("each profile's choice sets only its own offer to save and its own Apple Passwords key", async () => {
  engine.available = true;
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], settings: { passwordManager: "ardia" } });
  work = S().createProfile({ name: "Work" });
  S().createWindow({ url: "https://a.example/", profileId: "default" });
  takeCalls();

  startPasswordManager();
  assert.deepEqual(calls("applePasswords"), [[[]]]);
  assert.deepEqual(calls("offerToSave"), [], "starting with every profile on Ardia leaves each profile's own choice alone");
  takeCalls();

  choosePasswordManager("default", "apple");
  await settle();
  assert.equal(profilePasswordManager(S(), "default"), "apple");
  assert.equal(profilePasswordManager(S(), work), "ardia");
  assert.deepEqual(calls("applePasswords"), [[[""]]]);
  assert.deepEqual(calls("offerToSave"), [["", false]], "Work keeps Ardia's save prompt");
  takeCalls();

  S().updateSettings({ showFullUrl: true });
  await settle();
  assert.deepEqual(engine.calls, [], "another setting changes nothing");

  choosePasswordManager(work, "none");
  await settle();
  assert.deepEqual(calls("offerToSave"), [[work, false]]);
  assert.deepEqual(calls("applePasswords"), [], "the profiles with the key are the same");
  takeCalls();

  choosePasswordManager(`incognito:1@default`, "ardia");
  await settle();
  assert.equal(S().profiles.default.passwordManager, "ardia", "a private window's choice is its profile's");
  assert.deepEqual(calls("offerToSave"), [["", true]]);
  assert.deepEqual(calls("applePasswords"), [[[]]]);
  takeCalls();
});

test("a new profile follows the install: Ardia on an install that had it, Apple Passwords on a new one", async () => {
  const later = S().createProfile({ name: "Later" });
  await settle();
  assert.equal(profilePasswordManager(S(), later), "ardia");
  assert.deepEqual(calls("offerToSave"), []);
  S().updateSettings({ passwordManager: "apple" }, { fromSync: true });
  await settle();
  assert.equal(profilePasswordManager(S(), later), "apple");
  assert.equal(profilePasswordManager(S(), "default"), "ardia", "a profile's own choice stays");
  assert.deepEqual(calls("offerToSave"), [[later, false]]);
  S().updateSettings({ passwordManager: "ardia" }, { fromSync: true });
  await settle();
  S().deleteProfile(later);
  takeCalls();
});

test("a write that couldn't reach an unloaded profile lands when it shows, and never undoes the person's own choice", async () => {
  stub.profileToggles.unloadable.add(work);
  choosePasswordManager(work, "ardia");
  await settle();
  await settle();
  assert.deepEqual(calls("offerToSave"), [], "the profile isn't loaded, so nothing reached it yet");
  stub.profileToggles.unloadable.delete(work);
  S().createWindow({ url: "https://b.example/", profileId: work });
  await settle();
  assert.equal(stub.profileToggles.user.get(work)?.passwords, true, "the owed write lands once the profile shows");
  takeCalls();

  await setPasswordAutofillFor(work, false);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(stub.profileToggles.user.get(work)?.passwords, false, "nothing queued turns it back on");
  assert.deepEqual(calls("offerToSave"), [[work, false]]);
  takeCalls();

  stub.profileToggles.unloadable.add(work);
  choosePasswordManager(work, "none");
  await settle();
  choosePasswordManager(work, "ardia");
  await settle();
  stub.profileToggles.unloadable.delete(work);
  await setPasswordAutofillFor(work, false);
  S().createWindow({ url: "https://c.example/", profileId: work });
  await settle();
  assert.equal(stub.profileToggles.user.get(work)?.passwords, false, "a pending write the person overrode is dropped");
  takeCalls();
});

test("Apple's iCloud Passwords extension takes over from the key in the profiles that run it, once Ardia may start its helper", async () => {
  const icloud = { id: ICLOUD_PASSWORDS_EXTENSION_ID, name: "iCloud Passwords", enabled: true };
  const other = { id: "aeblfdkhhhdcdjpifhhbdiojplfjncoa", name: "1Password", enabled: true };
  choosePasswordManager("default", "apple");
  await settle();
  choosePasswordManager(work, "apple");
  await settle();
  takeCalls();

  useExtensions.setState({ lists: { "": [other], [work]: [icloud] } });
  await settle();
  assert.deepEqual(calls("applePasswords"), [], "without Apple's grant the helper can't start, so the key stays everywhere");

  engine.extensionSupported = true;
  useExtensions.setState({ lists: { "": [other], [work]: [icloud, other] } });
  await settle();
  assert.deepEqual(calls("applePasswords"), [[["", work].sort(), [work]]]);
  takeCalls();

  useExtensions.setState({ lists: { "": [other], [work]: [{ ...icloud, enabled: false }, other] } });
  await settle();
  assert.deepEqual(calls("applePasswords"), [[["", work].sort()]], "turning the extension off brings the key back");
  engine.extensionSupported = false;
  useExtensions.setState({ lists: {} });
  takeCalls();
});
