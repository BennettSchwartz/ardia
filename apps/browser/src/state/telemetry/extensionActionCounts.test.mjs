import assert from "node:assert/strict";
import { test } from "node:test";

const { noteExtensionAction, takeExtensionActionCounts } = await import("./extensionActionCounts.ts");

test("toolbar runs are counted by what they answered, and taking the counts starts them over", () => {
  noteExtensionAction("popup");
  noteExtensionAction("popup");
  noteExtensionAction("sidePanel");
  noteExtensionAction("none");
  noteExtensionAction("menu");
  assert.deepEqual(takeExtensionActionCounts(), { extension_action_popups: 2, extension_action_side_panels: 1, extension_action_nothing: 1, extension_action_menus: 1 });
  assert.deepEqual(takeExtensionActionCounts(), { extension_action_popups: 0, extension_action_side_panels: 0, extension_action_nothing: 0, extension_action_menus: 0 });
});
