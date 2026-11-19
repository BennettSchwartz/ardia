import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const stub = await import("../../test-native/index.ts");
const { methodSpec } = await import("./socketCatalog.ts");
const { showPasswordPrompt } = await import("../site/prompts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round4-test");

const { call, ok } = socketClient(35);

const item = (path, title, more) => ({ path, title, enabled: true, checked: false, separator: false, ...more });

test("menus.bar and a tracked menu bar are refused while the menu bar reflects a private window", async () => {
  const { windowId } = await freshWindow();
  const minimize = item([5, 0], "Minimize", { action: "performMiniaturize:", ref: "sel:performMiniaturize:@Window\u001fMinimize" });
  stub.surfaces.bar = [item([5], "Window", { submenu: [minimize] })];
  stub.surfaces.open = [{ id: "pb1", kind: "menuBar", window: windowId, reflectsPrivate: true, items: [minimize] }];
  stub.surfaces.barReflectsPrivate = true;
  try {
    const bar = await call("menus.bar");
    assert.equal(bar.error?.code, "refused");
    assert.match(bar.error.message, /private window/);
    assert.deepEqual(await ok("menus.open"), [], "a tracked bar that reflects a private window isn't listed");
    const chose = await call("menus.choose", { menu: "pb1", path: minimize.path, ref: minimize.ref });
    assert.equal(chose.error?.code, "refused");
    assert.equal((await call("menus.runBar", { path: minimize.path, ref: minimize.ref, window: windowId })).error?.code, "refused");
  } finally {
    stub.surfaces.barReflectsPrivate = false;
  }
});

test("a command doesn't run when its menu closed during the native check", async () => {
  const { windowId } = await freshWindow();
  const newTab = item([1, 0], "New Tab", { command: "newTab", ref: "cmd:newTab@File\u001fNew Tab" });
  stub.surfaces.bar = [item([1], "File", { submenu: [newTab] })];
  stub.surfaces.open = [{ id: "cl1", kind: "menuBar", window: windowId, items: [newTab] }];
  const tabsBefore = Object.keys(S().tabs).length;
  stub.surfaces.checkHook = () => stub.surfaces.emit({ type: "menuClosed", id: "cl1", kind: "menuBar" });
  const reply = await call("menus.choose", { menu: "cl1", path: newTab.path, ref: newTab.ref });
  stub.surfaces.checkHook = null;
  assert.equal(reply.error?.code, "no_window");
  await tick();
  assert.equal(Object.keys(S().tabs).length, tabsBefore, "run never ran");
});

test("Arrange in Front runs with no private window open and is refused with one", async () => {
  const { windowId } = await freshWindow();
  const arrange = item([5, 3], "Arrange in Front", { action: "arrangeWindowsInFront:", ref: "sel:arrangeWindowsInFront:@Window\u001fArrange in Front" });
  stub.surfaces.bar = [item([5], "Window", { submenu: [arrange] })];
  stub.surfaces.performed.length = 0;
  assert.deepEqual(await ok("menus.runBar", { path: arrange.path, ref: arrange.ref, window: windowId }), { ok: true, title: "performed", action: "arrangeWindowsInFront:" });
  S().createWindow({ kind: "private", url: "https://p.example/" });
  assert.equal((await call("menus.runBar", { path: arrange.path, ref: arrange.ref, window: windowId })).error?.code, "refused");
  assert.equal(stub.surfaces.performed.length, 1);
});

test("the primary username is cut to 256 characters in the listing and the event", async () => {
  const { tab } = await freshWindow("https://login.example/");
  await ok("subscribe", { events: ["password.prompted"] });
  stub.controlSocket.broadcasts.length = 0;
  const long = "x".repeat(400);
  showPasswordPrompt(tab, { state: "save", origin: "https://login.example", username: long, passwordLength: 4, federation: "", usernames: [] });
  await tick();
  const [row] = await ok("passwords.prompts");
  assert.equal(row.username.length, 256);
  const event = stub.controlSocket.broadcasts.map((b) => JSON.parse(b.line)).find((e) => e.event === "password.prompted");
  assert.equal(event.data.username.length, 256);
  await ok("subscribe", { events: [] });
});

test("method descriptions don't offer what the socket refuses", () => {
  const runBar = methodSpec("menus.runBar").description;
  for (const word of ["Copy", "Paste", "Undo"]) assert.equal(runBar.includes(word), false, word);
  assert.match(methodSpec("menus.choose").description, /captured page menu/);
});
