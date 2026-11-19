import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { usePages } = await import("../tabs/pageState.ts");
const { webviews } = await import("../../platform/webviews.ts");
const stub = await import("../../test-native/index.ts");
const { showAutofillPrompt, answerAutofillPrompt } = await import("../site/prompts.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round2-test");

const { call, ok } = socketClient(33);

const item = (path, title, more) => ({ path, title, enabled: true, checked: false, separator: false, ...more });

test("the on-screen autofill buttons answer only the prompt they were drawn for", async () => {
  const { tab } = await freshWindow("https://shop.example/");
  const answers = [];
  webviews.set(tab, { resolveAutofillPrompt: (...a) => answers.push(a) });
  const card = (id) => ({ id, kind: "saveCard", origin: "https://shop.example", title: "", message: "", accept: "", decline: "", footer: "", lines: [] });
  showAutofillPrompt(tab, card(3), 3);
  showAutofillPrompt(tab, card(4), 4);
  assert.equal(answerAutofillPrompt(tab, "accept", 3), false);
  assert.deepEqual(answers, []);
  assert.equal(answerAutofillPrompt(tab, "decline", 4), true);
  assert.deepEqual(answers, [[4, "decline"]]);
  webviews.delete(tab);
});

test("menus.bar and a tracked menu bar leave out rows for private or unknown windows", async () => {
  const { windowId } = await freshWindow("https://a.example/");
  const priv = S().createWindow({ kind: "private", url: "https://secret.example/" });
  const windowMenu = item([5], "Window", {
    submenu: [
      item([5, 0], "Minimize", { action: "performMiniaturize:", ref: "sel:performMiniaturize:@Window\u001fMinimize" }),
      item([5, 8], "a.example", { action: "makeKeyAndOrderFront:", ref: "sel:makeKeyAndOrderFront:@Window\u001fa.example", boundWindow: windowId }),
      item([5, 9], "Secret private title", { action: "makeKeyAndOrderFront:", ref: "x", boundWindow: priv }),
      item([5, 10], "DevTools", { action: "makeKeyAndOrderFront:", ref: "y", boundWindow: "" }),
      item([5, 11], "Move Tab to Window", { submenu: [item([5, 11, 0], "Secret private title", { command: "moveTabToWindow", arg: priv, ref: "z", boundWindow: priv })] }),
    ],
  });
  stub.surfaces.bar = [windowMenu];
  stub.surfaces.open = [{ id: "wb1", kind: "menuBar", window: windowId, items: windowMenu.submenu }];
  const text = JSON.stringify([await ok("menus.bar"), await ok("menus.open")]);
  assert.equal(text.includes("Secret private title"), false);
  assert.equal(text.includes("DevTools"), false);
  assert.ok(text.includes("a.example"));
  assert.equal((await call("menus.runBar", { path: [5, 9], ref: "x" })).error.code, "no_window");
});

test("Minimize All and Arrange in Front are refused while a private window is open, and allowed otherwise", async () => {
  const { windowId } = await freshWindow();
  const minimizeAll = item([5, 1], "Minimize All", { action: "miniaturizeAll:", ref: "sel:miniaturizeAll:@Window\u001fMinimize All" });
  const arrange = item([5, 3], "Arrange in Front", { action: "arrangeWindowsInFront:", ref: "sel:arrangeWindowsInFront:@Window\u001fArrange in Front" });
  stub.surfaces.bar = [item([5], "Window", { submenu: [minimizeAll, arrange] })];
  stub.surfaces.performed.length = 0;
  await ok("menus.runBar", { path: minimizeAll.path, ref: minimizeAll.ref, window: windowId });
  assert.equal(stub.surfaces.performed.length, 1);
  S().createWindow({ kind: "private", url: "https://p.example/" });
  for (const it of [minimizeAll, arrange]) assert.equal((await call("menus.runBar", { path: it.path, ref: it.ref, window: windowId })).error.code, "refused");
  assert.equal(stub.surfaces.performed.length, 1);
});

test("a menu bar with no key window sends window actions to the window it was listed for", async () => {
  await freshWindow();
  const minimize = item([5, 0], "Minimize", { action: "performMiniaturize:", ref: "sel:performMiniaturize:@Window\u001fMinimize" });
  stub.surfaces.bar = [item([5], "Window", { submenu: [minimize] })];
  stub.surfaces.open = [{ id: "kb1", kind: "menuBar", keyless: true, items: [minimize] }];
  stub.surfaces.performed.length = 0;
  const [listed] = await ok("menus.open");
  await ok("menus.choose", { menu: "kb1", path: minimize.path, ref: minimize.ref });
  assert.deepEqual([stub.surfaces.performed.at(-1).menu, stub.surfaces.performed.at(-1).windowId], ["kb1", listed.window], "native gets the tracked menu and the listed window, and refuses when no window is key");
});

test("menus.choose resolves a path only inside the tracked menu", async () => {
  const { windowId } = await freshWindow();
  const copy = item([2, 0], "Copy", { action: "copy:", ref: "sel:copy:@Edit\u001fCopy" });
  const minimize = item([5, 0], "Minimize", { action: "performMiniaturize:", ref: "sel:performMiniaturize:@Window\u001fMinimize" });
  stub.surfaces.bar = [item([2], "Edit", { submenu: [copy] }), item([5], "Window", { submenu: [minimize] })];
  stub.surfaces.open = [{ id: "e1", kind: "menuBar", window: windowId, items: [copy] }];
  stub.surfaces.performed.length = 0;
  assert.equal((await call("menus.choose", { menu: "e1", path: minimize.path, ref: minimize.ref })).error.code, "no_window");
  assert.equal((await call("menus.choose", { menu: "e1", path: copy.path, ref: minimize.ref })).error.code, "refused");
  assert.deepEqual(stub.surfaces.performed, []);
});

test("turning control off during the native check stops a menu bar command before run", async () => {
  const { windowId } = await freshWindow();
  const newTab = item([1, 0], "New Tab", { command: "newTab", ref: "cmd:newTab@File\u001fNew Tab" });
  stub.surfaces.bar = [item([1], "File", { submenu: [newTab] })];
  stub.surfaces.open = [{ id: "f1", kind: "menuBar", window: windowId, items: [newTab] }];
  const tabsBefore = Object.keys(S().tabs).length;
  stub.surfaces.checkHook = () => S().updateSettings({ cliControl: false });
  const reply = await call("menus.choose", { menu: "f1", path: newTab.path, ref: newTab.ref });
  stub.surfaces.checkHook = null;
  assert.equal(reply.error?.code, "failed");
  await tick();
  assert.equal(Object.keys(S().tabs).length, tabsBefore, "run never ran");
});

