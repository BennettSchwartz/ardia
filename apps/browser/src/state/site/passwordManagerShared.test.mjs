import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { markTabReady } = await import("../tabs/pageState.ts");
const { choosePasswordManager, profilePasswordManager, startPasswordManager } = await import("./passwordManager.ts");

const engine = stub.passwordManagerEngine;
const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const tabIn = (profileId, url) => {
  const windowId = S().createWindow({ url, profileId });
  return Object.values(S().tabs).find((t) => t?.windowId === windowId && t.url === url).id;
};

test("profiles that share browser data share one choice, so the key and the save prompt agree in JS and natively", async () => {
  engine.available = true;
  S().hydrate({ profiles: { default: PERSONAL, work: { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1, dataId: "default" } }, profileOrder: ["default", "work"], settings: { passwordManager: "ardia" } });
  startPasswordManager();
  choosePasswordManager("default", "apple");
  await settle();
  assert.equal(profilePasswordManager(S(), "default"), "apple");
  assert.equal(profilePasswordManager(S(), "work"), "apple", "Work shares Personal's data, so it shares the choice");
  assert.deepEqual(engine.profiles, [""], "natively the shared data's profile is in Apple mode");

  choosePasswordManager("work", "ardia");
  await settle();
  assert.equal(profilePasswordManager(S(), "default"), "ardia");
  assert.deepEqual(engine.profiles, []);
  assert.equal(profilePasswordManager(S(), "incognito:1@default"), "ardia", "a private window follows its profile's data");
});

test("a write still pending is retried on every tab that gets ready in its profile", async () => {
  S().createProfile({ name: "Other" });
  const other = Object.keys(S().profiles).find((id) => S().profiles[id].name === "Other");
  choosePasswordManager(other, "ardia");
  await settle();
  markTabReady(tabIn(other, "https://first.example/"));
  stub.profileToggles.unloadable.add(other);
  choosePasswordManager(other, "apple");
  await settle();
  assert.notEqual(stub.profileToggles.user.get(other)?.passwords, false, "the write failed while the profile couldn't load");
  stub.profileToggles.unloadable.delete(other);
  markTabReady(tabIn(other, "https://second.example/"));
  await settle();
  assert.equal(stub.profileToggles.user.get(other)?.passwords, false, "the next ready tab in the profile retries it");
});
