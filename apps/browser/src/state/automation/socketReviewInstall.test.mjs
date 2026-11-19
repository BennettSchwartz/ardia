import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { useExtensions, confirmInstall, cancelInstall, showInstallPrompt, loadUnpacked, refreshExtensions } = await import("../extensions/actions.ts");
const { SETTINGS_WINDOW_ID } = await import("../settings/settingsWindows.ts");
const stub = await import("../../test-native/index.ts");
const { extensionWorld, gate, row } = await import("./fixtures/extensionWorld.mjs");

const S = () => useBrowser.getState();
after(() => S().updateSettings({ cliControl: false }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};
let nextId = 0;
const CONNECTION = 62;

function send(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: CONNECTION, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  const mine = () => stub.controlSocket.replies.slice(before).find((r) => r.connection === CONNECTION && JSON.parse(r.line).id === id);
  return async () => {
    for (let i = 0; i < 400 && !mine(); i++) await tick();
    assert.ok(mine(), `a reply to ${method}`);
    return JSON.parse(mine().line);
  };
}
const call = (method, params) => send(method, params)();
const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

async function setup() {
  cancelInstall();
  useExtensions.setState({ install: null, lists: {} });
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  return { windowId, ...extensionWorld() };
}

async function loadFromSettings(folder, profile = "") {
  stub.chosenExtensionFolder.next = folder;
  try {
    assert.equal(await loadUnpacked(SETTINGS_WINDOW_ID, profile), true);
  } finally {
    stub.chosenExtensionFolder.next = null;
  }
  return useExtensions.getState().install;
}

test("a socket folder install is refused on every platform, before any path check or read", async () => {
  const { folders } = await setup();
  folders.set("/tmp/x/ext", { id: "x" });
  let inspected = 0;
  const engine = globalThis.acTestUserScripts.engine;
  const inspect = engine.inspect;
  engine.inspect = async (...args) => (inspected++, inspect(...args));
  try {
    for (const params of [{ folder: "/tmp/x/ext" }, { folder: "relative" }, { folder: "/tmp/x/ext", webStore: "abcdefghijklmnopabcdefghijklmnop" }]) {
      const reply = await call("extensions.install", params);
      assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
      assert.equal(reply.error.message, "installing an unpacked folder from the socket isn't supported; use Settings › Extensions › Load Unpacked");
    }
    assert.equal(inspected, 0);
    assert.equal(useExtensions.getState().install, null);
  } finally {
    engine.inspect = inspect;
  }
});

test("Settings' Load Unpacked inspects and installs the chosen folder in place, as on main", async () => {
  const { folders, installs, list } = await setup();
  folders.set("/Users/me/dev/ext", { id: "inplace", version: "1.0" });
  const shown = await loadFromSettings("/Users/me/dev/ext");
  assert.deepEqual([shown.status, shown.pkg.path, shown.windowId], ["ready", "/Users/me/dev/ext", SETTINGS_WINDOW_ID]);
  assert.deepEqual(Object.keys(shown.pkg).filter((k) => ["digest", "staged", "installId", "installPath"].includes(k)), []);
  await confirmInstall(shown.key);
  assert.deepEqual(installs, [{ path: "/Users/me/dev/ext", id: "inplace", version: "1.0" }]);
  assert.equal(list[0].path, "/Users/me/dev/ext");
  assert.equal(useExtensions.getState().install, null);
});

test("once Add is pressed, Cancel and a competing prompt leave the install alone, and the prompt shows after", async () => {
  const { folders, gates, installs, windowId } = await setup();
  folders.set("/tmp/h/ext", { id: "hhh" });
  const shown = await loadFromSettings("/tmp/h/ext");
  const held = gate();
  gates.install = held.shut;
  void confirmInstall(shown.key);
  await settle();
  cancelInstall(shown.key);
  showInstallPrompt(windowId, { requestId: "r1", profile: "", type: "install", name: "Other", icon: "", permissions: [] });
  await settle();
  assert.equal(useExtensions.getState().install?.status, "installing", "the sheet stays on Adding…");
  held.open();
  await settle();
  assert.equal(installs.length, 1);
  assert.equal(useExtensions.getState().install?.status, "prompt", "the prompt that came in meanwhile shows once the install is done");
  cancelInstall();
  gates.install = null;
});

test("closing the window while Adding… leaves no error sheet behind for a window that's gone", async () => {
  const { folders, gates } = await setup();
  const other = S().createWindow({ url: "https://b.example/" });
  folders.set("/tmp/i/ext", { id: "iii" });
  stub.chosenExtensionFolder.next = "/tmp/i/ext";
  await loadUnpacked(other, "");
  stub.chosenExtensionFolder.next = null;
  const shown = useExtensions.getState().install;
  const refusal = gate();
  gates.install = refusal.shut.then(() => {
    throw new Error("Chromium refused it");
  });
  void confirmInstall(shown.key);
  await settle();
  S().closeWindow(other);
  refusal.open();
  await settle();
  assert.equal(useExtensions.getState().install, null);
  gates.install = null;
});

test("the Web Store fast path checks control after the list it waited on", async () => {
  const { list, gates } = await setup();
  list.push(row("abcdefghijklmnopabcdefghijklmnop"));
  const held = gate();
  gates.list = held.shut;
  const pending = send("extensions.install", { webStore: "abcdefghijklmnopabcdefghijklmnop" });
  await settle();
  S().updateSettings({ cliControl: false });
  held.open();
  assert.equal((await pending()).error?.code, "failed");
  gates.list = null;
});

test("configure refuses Incognito for an unpacked extension, before changing anything", async () => {
  const { list } = await setup();
  list.push(row("unpacked", { path: "/Users/me/dev/ext", siteAccess: "ON_CLICK", incognitoAllowed: true }));
  const reply = await call("extensions.configure", { id: "unpacked", siteAccess: "allSites", incognito: true });
  assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
  assert.match(reply.error.message, /needs engine support/);
  assert.deepEqual([list[0].siteAccess, list[0].incognito], ["ON_CLICK", false], "site access didn't change first");
  assert.equal((await ok("extensions.configure", { id: "unpacked", siteAccess: "allSites" })).siteAccess, "ON_ALL_SITES", "other settings still change");
});

test("configure checks a packed extension's Incognito against the list Chromium gives now, not the cached row", async () => {
  const { list } = await setup();
  list.push(row("packed", { siteAccess: "ON_CLICK", incognitoAllowed: true }));
  await refreshExtensions("");
  list[0].incognitoAllowed = false;
  const reply = await call("extensions.configure", { id: "packed", siteAccess: "allSites", incognito: true });
  assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
  assert.equal(list[0].siteAccess, "ON_CLICK");
  list[0].incognitoAllowed = true;
  assert.equal((await ok("extensions.configure", { id: "packed", incognito: true })).incognito, true);
});

test("configure answers failed when the readback after its write fails, never the cached row", async () => {
  const { list, gates } = await setup();
  list.push(row("rb"));
  await refreshExtensions("");
  gates.breakListsOnWrite = true;
  const reply = await call("extensions.configure", { id: "rb", incognito: true });
  gates.breakListsOnWrite = false;
  gates.listFails = false;
  assert.equal(list[0].incognito, true, "the write happened");
  assert.equal(reply.error?.code, "failed", JSON.stringify(reply));
  assert.match(reply.error.message, /couldn't read the profile's extensions/);
});
