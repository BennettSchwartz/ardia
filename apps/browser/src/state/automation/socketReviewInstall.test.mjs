import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { useExtensions, confirmInstall, cancelInstall, showInstallPrompt, refreshExtensions, installWatchCount, showInstallSheet, nextInstallKey } = await import("../extensions/actions.ts");
const stub = await import("../../test-native/index.ts");
const { extensionWorld, gate, row } = await import("./fixtures/extensionWorld.mjs");

const S = () => useBrowser.getState();
after(() => S().updateSettings({ cliControl: false }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;
const CONNECTION = 62;

function send(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: CONNECTION, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  const mine = () => stub.controlSocket.replies.slice(before).find((r) => r.connection === CONNECTION && JSON.parse(r.line).id === id);
  const reply = async () => {
    for (let i = 0; i < 400 && !mine(); i++) await tick();
    assert.ok(mine(), `a reply to ${method}`);
    return JSON.parse(mine().line);
  };
  reply.answered = () => !!mine();
  return reply;
}
const ok = async (method, params) => {
  const reply = await send(method, params)();
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const sheet = async () => {
  for (let i = 0; i < 50 && useExtensions.getState().install?.status !== "ready"; i++) await tick();
  return useExtensions.getState().install;
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

async function setup() {
  cancelInstall();
  useExtensions.setState({ install: null });
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  return { windowId, ...extensionWorld() };
}

test("once Add is pressed, Cancel and a competing prompt leave the install alone and the reply waits for Chromium", async () => {
  const { folders, gates, installs } = await setup();
  folders.set("/tmp/h/ext", { id: "hhh", digest: "d-h" });
  const pending = send("extensions.install", { folder: "/tmp/h/ext" });
  const shown = await sheet();
  const held = gate();
  gates.install = held.shut;
  void confirmInstall(shown.key);
  await settle();
  cancelInstall(shown.key);
  showInstallPrompt(shown.windowId, { requestId: "r1", profile: shown.profile, type: "install", name: "Other", icon: "", permissions: [] });
  await settle();
  assert.equal(useExtensions.getState().install?.status, "installing", "the sheet stays on Adding…");
  assert.equal(pending.answered(), false, "no answer before Chromium's");
  held.open();
  const reply = await pending();
  assert.equal(reply.result?.installed, true, JSON.stringify(reply));
  assert.equal(installs.length, 1);
  assert.equal(useExtensions.getState().install?.status, "prompt", "the prompt that came in meanwhile shows once the install is done");
  cancelInstall();
  gates.install = null;
});

test("closing the window while Adding… waits for Chromium's answer", async () => {
  const { folders, gates, windowId } = await setup();
  folders.set("/tmp/i/ext", { id: "iii", digest: "d-i" });
  const pending = send("extensions.install", { folder: "/tmp/i/ext" });
  const shown = await sheet();
  const held = gate();
  gates.install = held.shut;
  void confirmInstall(shown.key);
  await settle();
  S().closeWindow(windowId);
  await settle();
  assert.equal(pending.answered(), false);
  held.open();
  assert.equal((await pending()).result?.installed, true);

  const other = S().createWindow({ url: "https://b.example/" });
  folders.set("/tmp/i2/ext", { id: "iii2", digest: "d-i2" });
  const failing = send("extensions.install", { folder: "/tmp/i2/ext" });
  const next = await sheet();
  assert.equal(next.windowId, other);
  const refusal = gate();
  gates.install = refusal.shut.then(() => {
    throw new Error("Chromium refused it");
  });
  void confirmInstall(next.key);
  await settle();
  S().closeWindow(other);
  await settle();
  assert.equal(failing.answered(), false);
  refusal.open();
  assert.equal((await failing()).error?.code, "failed");
  await settle();
  assert.equal(useExtensions.getState().install, null, "no error sheet left behind for a window that's gone");
  gates.install = null;
});

test("an install from Settings keeps no result nobody reads", async () => {
  const { folders, windowId } = await setup();
  folders.set("/tmp/j/ext", { id: "jjj", digest: "d-j" });
  const { inspectUnpackedExtension } = await import("../../platform/extensions.ts");
  const pkg = await inspectUnpackedExtension("/tmp/j/ext");
  const key = nextInstallKey();
  showInstallSheet({ key, windowId, profile: "", source: "unpacked", status: "ready", pkg });
  await confirmInstall(key);
  assert.equal(useExtensions.getState().install, null);
  assert.equal(installWatchCount(), 0);
});

test("Add re-checks control and the profile for a socket's sheet, and installs nothing when either is gone", async () => {
  const { folders, list } = await setup();
  folders.set("/tmp/k/ext", { id: "kkk", digest: "d-k" });
  const off = send("extensions.install", { folder: "/tmp/k/ext" });
  const first = await sheet();
  S().updateSettings({ cliControl: false });
  await confirmInstall(first.key);
  assert.equal((await off()).error?.code, "failed");
  assert.equal(list.length, 0);
  assert.ok(stub.discardedStages.includes(first.pkg.staged));
  cancelInstall();
  S().updateSettings({ cliControl: true });
  await settle();

  const work = await ok("profiles.create", { name: "Work" });
  const lost = send("extensions.install", { folder: "/tmp/k/ext", profile: work.id });
  const second = await sheet();
  S().deleteProfile(work.id);
  await confirmInstall(second.key);
  const reply = await lost();
  assert.equal(reply.error?.code, "failed", JSON.stringify(reply));
  assert.equal(list.length, 0);
  cancelInstall();
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

test("configure refuses Incognito before any write when the extension can't run there", async () => {
  const { list } = await setup();
  list.push(row("noinc", { siteAccess: "ON_CLICK", incognitoAllowed: false }));
  await ok("extensions.list");
  assert.equal((await send("extensions.configure", { id: "noinc", siteAccess: "allSites", incognito: true })()).error?.code, "refused");
  assert.equal(list[0].siteAccess, "ON_CLICK", "site access didn't change first");
});

test("configure reads back with a list started after its write, not one already in flight", async () => {
  const { list, gates } = await setup();
  list.push(row("fresh"));
  await ok("extensions.list");
  const held = gate();
  gates.list = held.shut;
  const stale = refreshExtensions("");
  const pending = send("extensions.configure", { id: "fresh", incognito: true });
  for (let i = 0; i < 50 && !list[0].incognito; i++) await tick();
  gates.list = null;
  held.open();
  await stale;
  const reply = await pending();
  assert.ok(!reply.error, JSON.stringify(reply.error));
  assert.equal(reply.result.incognito, true);
});
