import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { engineProfile } = await import("../browser/model.ts");
const { profilePasswordManager, startPasswordManager } = await import("./passwordManager.ts");

const engine = stub.passwordManagerEngine;
const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("sharers whose data owner is gone keep one choice, whatever order the sidebar puts them in, in JS and natively", async () => {
  engine.available = true;
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], settings: { passwordManager: "ardia" } });
  const owner = S().createProfile({ name: "Owner" });
  const first = S().createProfile({ name: "First", shareWith: owner });
  const second = S().createProfile({ name: "Second", shareWith: owner });
  S().updateProfile(first, { passwordManager: "apple" });
  S().updateProfile(second, { passwordManager: "none" });
  startPasswordManager();
  await settle();
  S().deleteProfile(owner);
  await settle();
  const data = engineProfile(S(), first);
  const before = profilePasswordManager(S(), first);
  assert.equal(profilePasswordManager(S(), second), before, "the sharers agree");
  assert.equal(engine.profiles.includes(data), before === "apple", "and native agrees");

  S().reorderProfiles([second, first, "default"]);
  await settle();
  assert.equal(profilePasswordManager(S(), first), before, "reordering the sidebar doesn't change the choice");
  assert.equal(engine.profiles.includes(data), profilePasswordManager(S(), first) === "apple", "native still agrees with JS");
  assert.equal(S().profiles[first].passwordManager, S().profiles[second].passwordManager, "both sharers store the same choice");
});
