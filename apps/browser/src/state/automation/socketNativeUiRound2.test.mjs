import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { usePages } = await import("../tabs/pageState.ts");
const { webviews } = await import("../../platform/webviews.ts");
const stub = await import("../../test-native/index.ts");
const { showPasswordPrompt, showAutofillPrompt, answerAutofillPrompt } = await import("../site/prompts.ts");
const { startPermissionPrompts } = await import("../site/permissions.ts");
const { currentEngineProfile } = await import("../browser/current.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-round2-test");

const { call, ok } = socketClient(33);

let slowId = 9000;
async function slowCall(method, params) {
  const id = ++slowId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 33, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, params }) });
  for (let waited = 0; waited < 8000; waited += 50) {
    const reply = stub.controlSocket.replies.slice(before).find((r) => r.connection === 33);
    if (reply) return JSON.parse(reply.line);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no reply to ${method}`);
}

const item = (path, title, more) => ({ path, title, enabled: true, checked: false, separator: false, ...more });

test("a password answer carries the offer it was listed for, so a replacement the engine already delivered is refused", async () => {
  const { tab } = await freshWindow("https://login.example/");
  let nativeOffer = 5;
  const seen = [];
  webviews.set(tab, { answerPasswordPrompt: async (action, expected) => (seen.push(expected), expected.offerSerial === nativeOffer) });
  showPasswordPrompt(tab, { state: "save", origin: "https://login.example", username: "a", passwordLength: 4, federation: "", usernames: [], offerSerial: 5 });
  const [row] = await ok("passwords.prompts");
  nativeOffer = 6;
  const reply = await call("passwords.respond", { tab, id: row.id, decision: "save" });
  assert.equal(reply.error?.code, "failed");
  assert.equal(seen[0].offerSerial, 5, "the native check gets the listed offer");
  assert.ok(usePages.getState().pages[tab].passwordPrompt, "the prompt stays up");
  showPasswordPrompt(tab, { state: "save", origin: "https://login.example", username: "a", passwordLength: 4, federation: "", usernames: [] });
  const [unnumbered] = await ok("passwords.prompts");
  seen.length = 0;
  assert.equal((await call("passwords.respond", { tab, id: unnumbered.id, decision: "save" })).error?.code, "failed");
  assert.deepEqual(seen, [], "an offer without a native serial never reaches the engine");
  webviews.delete(tab);
});

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
  assert.equal(stub.surfaces.performed.at(-1).windowId, listed.window);
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

test("allow is confirmed by the site's setting, and an answer the setting doesn't show is an unknown outcome, not ok", async () => {
  const { tab } = await freshWindow("https://cam.example/");
  startPermissionPrompts();
  const profile = currentEngineProfile(S().tabs[tab].profileId);
  stub.emitPermission({ id: "c1", tabId: tab, origin: "https://cam.example/", permissions: ["camera"] });
  stub.emitPermission({ id: "c2", tabId: tab, origin: "https://cam.example/", permissions: ["microphone"] });
  await tick();
  stub.permissionReadback.onAnswer = ({ id }) =>
    id === "c1" && setTimeout(() => stub.siteSettingsDb.set(`${profile}\nhttps://cam.example`, { camera: "allow" }), 400);
  assert.deepEqual((await slowCall("permissions.respond", { id: "c1", decision: "allow" })).result, { ok: true, id: "c1", decision: "allow" });
  assert.equal(usePages.getState().pages[tab].permission.id, "c2");
  stub.permissionReadback.onAnswer = null;
  const started = Date.now();
  const reply = await slowCall("permissions.respond", { id: "c2", decision: "block" });
  assert.equal(reply.error?.code, "failed");
  assert.match(reply.error.message, /outcome is unknown/);
  assert.ok(Date.now() - started >= 4500);
  assert.equal(usePages.getState().pages[tab].permission.id, "c2", "the queue waits for a confirmation");
});

test("a permission whose kinds have no readable setting is refused", async () => {
  const { tab } = await freshWindow("https://cam.example/");
  startPermissionPrompts();
  stub.emitPermission({ id: "s1", tabId: tab, origin: "https://cam.example/", permissions: ["screen"] });
  await tick();
  stub.resolvedPermissions.length = 0;
  assert.equal((await call("permissions.respond", { id: "s1", decision: "allow" })).error.code, "refused");
  assert.deepEqual(stub.resolvedPermissions, []);
});
