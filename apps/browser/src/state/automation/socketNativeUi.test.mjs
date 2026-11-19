import assert from "node:assert/strict";
import { test } from "node:test";
const { S, tick, socketClient, freshWindow } = await import("./fixtures/socketHarness.mjs");
const { methodSpec, accessProblem, familyOf } = await import("./socketCatalog.ts");
const { usePages, patchPage } = await import("../tabs/pageState.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { takeCliCounts } = await import("../telemetry/cliCounts.ts");
const stub = await import("../../test-native/index.ts");
const { showPasswordPrompt } = await import("../site/prompts.ts");
const { currentEngineProfile } = await import("../browser/current.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "socket-native-ui-test");

const { call, ok } = socketClient(31);

async function promptOn(tab, id, permissions) {
  const { startPermissionPrompts } = await import("../site/permissions.ts");
  startPermissionPrompts();
  stub.emitPermission({ id, tabId: tab, origin: "https://cam.example", permissions });
  await tick();
}

function readsBack(profileValue) {
  stub.permissionReadback.onAnswer = ({ id, result, remember }) => {
    const origin = "https://cam.example";
    const kinds = { p10: ["camera"], p11: ["notifications"], p20: ["location"], p21: ["microphone"] }[id] ?? [];
    if (!remember) return;
    for (const profile of profileValue) {
      const key = `${profile}\n${origin}`;
      stub.siteSettingsDb.set(key, { ...(stub.siteSettingsDb.get(key) ?? {}), ...Object.fromEntries(kinds.map((k) => [k, result === "accept" ? "allow" : "block"])) });
    }
  };
}

test("a permission prompt on screen is listed and answered through the prompt's own path", async () => {
  const { windowId, tab } = await freshWindow("https://cam.example/");
  readsBack([currentEngineProfile(S().tabs[tab].profileId)]);
  await promptOn(tab, "p10", ["camera"]);
  await promptOn(tab, "p11", ["notifications"]);
  const listed = await ok("permissions.prompts");
  assert.deepEqual(listed, [{ id: "p10", window: windowId, tab, origin: "https://cam.example", permissions: ["camera"], queued: 1 }]);
  stub.resolvedPermissions.length = 0;
  assert.deepEqual(await ok("permissions.respond", { id: "p10", decision: "allow" }), { ok: true, id: "p10", decision: "allow" });
  assert.deepEqual(stub.resolvedPermissions, [{ id: "p10", result: "accept", remember: true }]);
  assert.equal(usePages.getState().pages[tab].permission.id, "p11", "the next prompt shows");
  assert.equal((await call("permissions.respond", { id: "p11", decision: "allowOnce" })).error.code, "refused");
  await ok("permissions.respond", { id: "p11", decision: "block" });
  assert.deepEqual(stub.resolvedPermissions.at(-1), { id: "p11", result: "deny", remember: true });
  assert.equal((await call("permissions.respond", { id: "p11", decision: "allow" })).error.code, "no_window");
  assert.equal((await call("permissions.respond", { id: "p12", decision: "maybe" })).error.code, "bad_request");
  stub.permissionReadback.onAnswer = null;
});

test("allowOnce and dismiss are refused, since nothing the engine shows confirms them", async () => {
  const { tab } = await freshWindow("https://cam.example/");
  await promptOn(tab, "p20", ["location"]);
  stub.resolvedPermissions.length = 0;
  assert.equal((await call("permissions.respond", { id: "p20", decision: "allowOnce" })).error.code, "refused");
  assert.equal((await call("permissions.respond", { id: "p20", decision: "dismiss" })).error.code, "refused");
  assert.deepEqual(stub.resolvedPermissions, []);
  assert.equal(usePages.getState().pages[tab].permission.id, "p20");
});

test("a prompt in a private window stays invisible", async () => {
  await freshWindow();
  const priv = S().createWindow({ kind: "private", url: "https://cam.example/" });
  const tab = S().windows[priv].activeTabIds[S().windows[priv].profileId];
  await promptOn(tab, "p30", ["camera"]);
  assert.deepEqual(await ok("permissions.prompts"), []);
  assert.equal((await call("permissions.respond", { id: "p30", decision: "allow" })).error.code, "no_window");
});

test("password and autofill prompts are answered with their own buttons, never showing the password", async () => {
  const { tab } = await freshWindow("https://login.example/");
  const answers = [];
  webviews.set(tab, {
    answerPasswordPrompt: async (...a) => (answers.push(["password", ...a]), true),
    answerAutofillPrompt: async (...a) => (answers.push(["autofill", ...a]), true),
  });
  showPasswordPrompt(tab, { state: "update", origin: "https://login.example", username: "me", passwordLength: 9, federation: "", usernames: ["me", "you"], offerSerial: 3 });
  const [row] = await ok("passwords.prompts");
  assert.equal(row.state, "update");
  assert.equal("passwordLength" in row, false);
  assert.equal((await call("passwords.respond", { tab, id: row.id, decision: "save" })).error.code, "bad_request");
  assert.deepEqual(row.usernames, [{ id: "u0", name: "me" }, { id: "u1", name: "you" }]);
  assert.equal((await call("passwords.respond", { tab, id: row.id, decision: "update", usernameId: "u7" })).error.code, "bad_request");
  await ok("passwords.respond", { tab, id: row.id, decision: "update", usernameId: "u1" });
  assert.deepEqual(answers.at(-1), ["password", "update", { state: "update", origin: "https://login.example", username: "me", offerSerial: 3 }, "you"]);
  assert.equal(usePages.getState().pages[tab].passwordPrompt, null);
  patchPage(tab, { autofillPrompt: { id: 4, kind: "saveCard", origin: "https://login.example", title: "Save card?", message: "", accept: "Save", decline: "No thanks", footer: "", lines: ["Visa 1234"] } });
  const [card] = await ok("autofill.prompts");
  assert.equal("lines" in card, false);
  await ok("autofill.respond", { tab, id: 4, decision: "decline" });
  assert.deepEqual(answers.at(-1), ["autofill", 4, "decline"]);
  assert.equal((await call("autofill.respond", { tab, id: 4, decision: "accept" })).error.code, "no_window");
  webviews.delete(tab);
});

test("open menus are listed, chosen from and closed through the native menu", async () => {
  const { windowId, tab } = await freshWindow();
  stub.surfaces.open = [
    { id: "m1", kind: "select", tab, window: windowId, items: [{ path: [0], title: "apple", enabled: true, checked: true, separator: false }] },
    { id: "m2", kind: "page", tab, window: windowId, items: [] },
    { id: "m3", kind: "menuBar", window: windowId, items: [] },
  ];
  const open = await ok("menus.open");
  assert.deepEqual(open.map((m) => [m.id, m.window, m.tab]), [["m1", windowId, tab], ["m2", windowId, tab], ["m3", windowId, null]]);
  assert.equal((await call("menus.choose", { menu: "m1", path: [] })).error.code, "bad_request");
  assert.deepEqual(await ok("menus.choose", { menu: "m1", path: [1] }), { ok: true, menu: "m1", kind: "select", title: "chosen" });
  assert.deepEqual(stub.surfaces.chosen.at(-1), { id: "m1", path: [1] });
  await ok("menus.dismiss", { menu: "m2" });
  assert.deepEqual((await ok("menus.open")).map((m) => m.id), ["m3"]);
  assert.equal((await call("menus.choose", { menu: "m1", path: [0] })).error.code, "no_window");
});

test("a page's menu in a private window is not listed", async () => {
  await freshWindow();
  const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  const tab = S().windows[priv].activeTabIds[S().windows[priv].profileId];
  stub.surfaces.open = [{ id: "m4", kind: "page", tab, window: priv, items: [] }, { id: "m5", kind: "select", window: priv, items: [] }];
  assert.deepEqual(await ok("menus.open"), []);
  assert.equal((await call("menus.dismiss", { menu: "m4" })).error.code, "no_window");
});

test("menus.runBar sends Ardia commands through run and other items through the menu", async () => {
  const { windowId } = await freshWindow();
  stub.surfaces.bar = [
    {
      path: [1],
      title: "File",
      enabled: true,
      checked: false,
      separator: false,
      submenu: [
        { path: [1, 0], ref: "cmd:newTab@File\u001fNew Tab", title: "New Tab", enabled: true, checked: false, separator: false, command: "newTab" },
        { path: [1, 2], ref: "cmd:newWindow@File\u001fOff", title: "Off", enabled: false, checked: false, separator: false, command: "newWindow" },
      ],
    },
    { path: [2], title: "Edit", enabled: true, checked: false, separator: false, submenu: [{ path: [2, 0], ref: "sel:copy:@Edit\u001fCopy", title: "Copy", enabled: true, checked: false, separator: false, action: "copy:" }] },
  ];
  const tabsBefore = S().windows[windowId].tabIds?.length ?? Object.values(S().tabs).filter((t) => t.windowId === windowId).length;
  assert.deepEqual(await ok("menus.runBar", { path: [1, 0], ref: "cmd:newTab@File\u001fNew Tab", window: windowId }), { ok: true, title: "New Tab", command: "newTab" });
  await tick();
  const tabsAfter = S().windows[windowId].tabIds?.length ?? Object.values(S().tabs).filter((t) => t.windowId === windowId).length;
  assert.ok(tabsAfter > tabsBefore, "run opened a tab");
  assert.equal((await call("menus.runBar", { path: [1, 2], ref: "cmd:newWindow@File\u001fOff" })).error.code, "refused");
  assert.equal((await call("menus.runBar", { path: [1, 1], ref: "x" })).error.code, "no_window");
  assert.deepEqual(await ok("menus.runBar", { path: [2, 0], ref: "sel:copy:@Edit\u001fCopy", window: windowId }), { ok: true, title: "performed", action: "copy:" });
  assert.deepEqual(stub.surfaces.performed.at(-1), { path: [2, 0], ref: "sel:copy:@Edit\u001fCopy", windowId });
  assert.equal((await ok("menus.bar")).length, 2);
});

test("menu and prompt events reach subscribers", async () => {
  const { windowId, tab } = await freshWindow("https://cam.example/");
  await ok("subscribe", { events: ["menu.opened", "menu.closed", "permission.prompted"] });
  stub.controlSocket.broadcasts.length = 0;
  stub.surfaces.emit({ type: "menuOpened", id: "m9", kind: "select", tab, window: windowId, items: [{ path: [0] }, { path: [1] }] });
  stub.surfaces.emit({ type: "menuClosed", id: "m9", kind: "select" });
  await promptOn(tab, "p40", ["camera"]);
  const events = stub.controlSocket.broadcasts.map((b) => JSON.parse(b.line));
  assert.deepEqual(events.map((e) => e.event), ["menu.opened", "menu.closed", "permission.prompted"]);
  assert.equal(events[0].data.items, 2);
  assert.equal(events[2].data.id, "p40");
  await ok("subscribe", { events: [] });
});

test("plugin sessions can't reach the native UI methods, and each family counts", async () => {
  await freshWindow();
  for (const name of ["permissions.prompts", "permissions.respond", "passwords.respond", "autofill.respond", "menus.open", "menus.choose", "menus.dismiss", "menus.bar", "menus.runBar"]) {
    assert.equal(accessProblem("plugin", methodSpec(name))?.code, "refused", name);
  }
  assert.equal(familyOf("menus.open"), "menus");
  assert.equal(familyOf("permissions.respond"), "permissions");
  takeCliCounts();
  stub.surfaces.open = [];
  await ok("menus.open");
  await ok("permissions.prompts");
  await call("menus.dismiss", { menu: "nope" });
  const counts = takeCliCounts();
  assert.equal(counts.cli_socket_calls_menus, 2);
  assert.equal(counts.cli_socket_calls_permissions, 1);
  assert.equal(counts.cli_socket_call_failures, 1);
});

test("the socket captures a hidden page's context menu only while it serves", async () => {
  await freshWindow();
  for (let i = 0; i < 10 && !stub.surfaces.captures; i++) await tick();
  assert.equal(stub.surfaces.captures, true);
  S().updateSettings({ cliControl: false });
  for (let i = 0; i < 10 && stub.surfaces.captures; i++) await tick();
  assert.equal(stub.surfaces.captures, false);
});
