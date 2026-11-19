import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;
const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) => (/\.png$/.test(id) ? { uri: id } : nodeRequire(id));

await import("../../../test-native/index.ts");
const { managerPopUp } = await import("./PasswordManagerRow.tsx");

const APPLE = { name: "apple-passwords", title: "Apple Passwords", spec: { fill: "system", fields: ["login"] }, builtIn: true, approval: "h" };

test("a stored plugin that is off shows as its own option, so picking Ardia is a change that gets saved", () => {
  const popUp = managerPopUp([], "plugin:apple-passwords", "ardia", "Apple Passwords");
  assert.equal(popUp.value, "plugin:apple-passwords");
  assert.deepEqual(
    popUp.options.map((o) => [o.value, o.title]),
    [
      ["ardia", "Ardia"],
      ["plugin:apple-passwords", "Apple Passwords (off)"],
      ["none", "None (an extension handles logins)"],
    ],
  );
  assert.notEqual(popUp.value, "ardia");
});

test("an available choice shows as itself with no extra option", () => {
  const on = managerPopUp([APPLE], "plugin:apple-passwords", "plugin:apple-passwords", "Apple Passwords");
  assert.equal(on.value, "plugin:apple-passwords");
  assert.equal(on.options.length, 3);
  const ardia = managerPopUp([APPLE], "ardia", "ardia", null);
  assert.equal(ardia.value, "ardia");
  assert.equal(ardia.options.length, 3);
  const never = managerPopUp([APPLE], undefined, "plugin:apple-passwords", null);
  assert.equal(never.value, "plugin:apple-passwords");
  assert.equal(never.options.length, 3);
});
