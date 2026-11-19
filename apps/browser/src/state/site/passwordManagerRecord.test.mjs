import assert from "node:assert/strict";
import { test } from "node:test";
const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { choosePasswordManager, startPasswordManager } = await import("./passwordManager.ts");

const engine = stub.passwordManagerEngine;
const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("Apple mode doesn't turn offer to save off until its record of that has landed, and leaves it on if the record can't be written", async () => {
  engine.available = true;
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], settings: { passwordManager: "ardia" } });
  startPasswordManager();
  await settle();

  stub.heldSaves.on = true;
  choosePasswordManager("default", "apple");
  await settle();
  assert.notEqual(stub.profileToggles.user.get("")?.passwords, false, "the record hasn't landed, so offer to save is still on");
  stub.heldSaves.on = false;
  for (const land of stub.heldSaves.queue.splice(0)) land();
  await settle();
  assert.equal(stub.profileToggles.user.get("")?.passwords, false, "once it has, Apple mode turns it off");
  assert.match(stub.docs.get("password-manager.json") ?? "", /"offerToSaveHeldOff":\[""\]/);

  choosePasswordManager("default", "ardia");
  await settle();
  assert.equal(stub.profileToggles.user.get("")?.passwords, true);

  stub.refusedSaves.on = true;
  try {
    choosePasswordManager("default", "apple");
    await settle();
    assert.equal(stub.profileToggles.user.get("")?.passwords, true, "without a record, offer to save stays on");
    choosePasswordManager("default", "ardia");
    await settle();
    assert.equal(stub.profileToggles.user.get("")?.passwords, true, "so switching back to Ardia finds it on");
  } finally {
    stub.refusedSaves.on = false;
  }
});
