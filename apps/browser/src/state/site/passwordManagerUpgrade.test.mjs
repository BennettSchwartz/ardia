import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { usePages, markTabReady } = await import("../tabs/pageState.ts");
const { startPasswordManager } = await import("./passwordManager.ts");

const engine = stub.passwordManagerEngine;
const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a new install starts on Apple Passwords", () => {
  engine.available = true;
  S().hydrate({});
  assert.equal(S().settings.passwordManager, "apple");
  assert.equal(S().settingsMeta.inferred.includes("passwordManager"), false);
});

test("someone updating from a build without the setting keeps Ardia's manager and its save prompt, with or without logins saved in it", async () => {
  engine.available = true;
  engine.logins = { "": [{ origin: "https://a.example", username: "me" }] };
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], settings: { showFullUrl: false } });
  assert.equal(S().settings.passwordManager, "ardia", "an existing install starts where it was");
  assert.equal(S().settingsMeta.inferred.includes("passwordManager"), true);

  const work = S().createProfile({ name: "Work" });
  const tabIn = (profileId) => {
    const windowId = S().createWindow({ url: "https://a.example/", profileId });
    return Object.values(S().tabs).find((t) => t?.windowId === windowId).id;
  };
  engine.calls.splice(0);
  startPasswordManager();
  markTabReady(tabIn("default"));
  engine.logins = {};
  markTabReady(tabIn(work));
  await settle();
  assert.equal(S().settings.passwordManager, "ardia", "a profile with no logins in Ardia doesn't move anyone to Apple Passwords");
  assert.deepEqual(engine.calls.filter((c) => c[0] === "applePasswords"), [["applePasswords", false]]);
  assert.deepEqual(engine.calls.filter((c) => c[0] === "offerToSave"), [], "each profile's own offer to save stays as it was");
  usePages.setState({ ready: {} });
});
