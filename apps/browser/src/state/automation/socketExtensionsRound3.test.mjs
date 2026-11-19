import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const actions = await import("../extensions/actions.ts");
const { PLATFORM_FEATURES } = await import("../../lib/platformFeatures.ts");
const { SETTINGS_WINDOW_ID } = await import("../settings/settingsWindows.ts");
const stub = await import("../../test-native/index.ts");
const { extensionWorld, row } = await import("./fixtures/extensionWorld.mjs");
const { useExtensions, confirmInstall, cancelInstall, sheetMounted, showInstallSheet, nextInstallKey, reloadFromSource, removeExtension, refreshExtensions } = actions;

const S = () => useBrowser.getState();
after(() => S().updateSettings({ cliControl: false }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};
let nextId = 0;
const CONNECTION = 63;

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
const sheet = async (status = "ready") => {
  for (let i = 0; i < 80 && useExtensions.getState().install?.status !== status; i++) await tick();
  return useExtensions.getState().install;
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

async function stagedPackage(folders, folder, id, profile = "") {
  folders.set(folder, { id, digest: `d-${id}` });
  const { inspectUnpackedExtension } = await import("../../platform/extensions.ts");
  return inspectUnpackedExtension(folder, profile);
}

test("a folder whose id the profile already has from somewhere else needs replace: true, and the sheet names what it replaces", async () => {
  const { folders, list } = await setup();
  folders.set("/tmp/r/ext", { id: "rrr", digest: "d-r", key: "keyed" });
  list.push(row("keyed", { name: "Old Keyed", path: "/elsewhere/ext" }));
  const refused = await call("extensions.install", { folder: "/tmp/r/ext" });
  assert.equal(refused.error?.code, "refused", JSON.stringify(refused));
  assert.match(refused.error.message, /Old Keyed.*replace: true/);
  assert.equal(useExtensions.getState().install, null);
  assert.equal(stub.discardedStages.at(-1)?.includes("stage-"), true, "the copy made for the refused request is thrown away");
  const pending = send("extensions.install", { folder: "/tmp/r/ext", replace: true });
  const shown = await sheet();
  assert.deepEqual(shown.review.replaces, { id: "keyed", name: "Old Keyed", path: "/elsewhere/ext" });
  cancelInstall(shown.key);
  assert.equal((await pending()).result?.installed, false);
});

test("a folder already loaded straight from its source is named on the sheet, since the copy gets a new id", async () => {
  const { folders, list } = await setup();
  list.push(row("direct", { name: "Direct One", path: "/tmp/old/ext" }));
  folders.set("/tmp/old/ext", { id: "copied", digest: "d-old" });
  const pending = send("extensions.install", { folder: "/tmp/old/ext" });
  const shown = await sheet();
  assert.deepEqual(shown.review.leaves, { id: "direct", name: "Direct One" });
  assert.equal(shown.review.replaces, undefined);
  cancelInstall(shown.key);
  await pending();
});

test("a Settings sheet that closes, a browser-window sheet whose window closes, and a failed Add each throw the copy away", async () => {
  const { folders, windowId, gates } = await setup();
  const settingsPkg = await stagedPackage(folders, "/tmp/s1/ext", "s1");
  const settingsKey = nextInstallKey();
  showInstallSheet({ key: settingsKey, windowId: SETTINGS_WINDOW_ID, profile: "", source: "unpacked", status: "ready", pkg: settingsPkg });
  const unmount = sheetMounted(settingsKey);
  await settle();
  assert.equal(useExtensions.getState().install?.key, settingsKey, "a mounted Settings sheet stays");
  unmount();
  await settle();
  assert.equal(useExtensions.getState().install, null);
  assert.ok(stub.discardedStages.includes(settingsPkg.staged), "closing Settings' sheet discards its copy");

  const other = S().createWindow({ url: "https://b.example/" });
  const windowPkg = await stagedPackage(folders, "/tmp/s2/ext", "s2");
  showInstallSheet({ key: nextInstallKey(), windowId: other, profile: "", source: "unpacked", status: "ready", pkg: windowPkg });
  S().closeWindow(other);
  await settle();
  assert.equal(useExtensions.getState().install, null);
  assert.ok(stub.discardedStages.includes(windowPkg.staged), "a closed window discards a non-socket sheet's copy");

  const failingPkg = await stagedPackage(folders, "/tmp/s3/ext", "s3");
  const failingKey = nextInstallKey();
  showInstallSheet({ key: failingKey, windowId, profile: "", source: "unpacked", status: "ready", pkg: failingPkg });
  gates.reject = "Chromium refused it";
  await confirmInstall(failingKey);
  gates.reject = null;
  assert.equal(useExtensions.getState().install?.status, "error");
  assert.ok(stub.discardedStages.includes(failingPkg.staged), "a failed Add discards the copy before the error is dismissed");
  cancelInstall(failingKey);

  const settingsError = nextInstallKey();
  const errorPkg = await stagedPackage(folders, "/tmp/s4/ext", "s4");
  showInstallSheet({ key: settingsError, windowId: SETTINGS_WINDOW_ID, profile: "", source: "unpacked", status: "ready", pkg: errorPkg });
  const shownInSettings = sheetMounted(settingsError);
  gates.reject = "Chromium refused it";
  await confirmInstall(settingsError);
  gates.reject = null;
  assert.equal(useExtensions.getState().install?.status, "error", "Settings keeps showing why the add failed");
  shownInSettings();
  await settle();
  assert.equal(useExtensions.getState().install, null);
});

test("configure checks Incognito against the list Chromium gives now, not the cached row", async () => {
  const { list } = await setup();
  list.push(row("inc", { siteAccess: "ON_CLICK", incognitoAllowed: true }));
  await refreshExtensions("");
  list[0].incognitoAllowed = false;
  const reply = await call("extensions.configure", { id: "inc", siteAccess: "allSites", incognito: true });
  assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
  assert.equal(list[0].siteAccess, "ON_CLICK");
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

test("on a platform that can't stage folders, a folder install is refused before any path check or read", async () => {
  const { folders } = await setup();
  let inspected = 0;
  folders.set("/tmp/x/ext", { id: "x", digest: "d-x" });
  const engine = globalThis.acTestUserScripts.engine;
  const inspect = engine.inspect;
  engine.inspect = async (...args) => (inspected++, inspect(...args));
  PLATFORM_FEATURES.stagesUnpackedFolders = false;
  try {
    for (const folder of ["relative/ext", "/tmp/x/ext"]) assert.equal((await call("extensions.install", { folder })).error?.code, "refused");
    assert.equal(inspected, 0);
  } finally {
    PLATFORM_FEATURES.stagesUnpackedFolders = true;
    engine.inspect = inspect;
  }
});

test("Reload from Source reloads quietly when the folder is unchanged and shows a sheet when it changed", async () => {
  const { folders, list, reloads, windowId } = await setup();
  folders.set("/tmp/rs/ext", { id: "rs", digest: "d-1" });
  list.push(row("rs", { path: "/data/live", managedSource: "/tmp/rs/ext", managedDigest: "d-1" }));
  const ext = list[0];
  assert.equal(await reloadFromSource(windowId, "", ext), false);
  assert.deepEqual(reloads, ["rs"]);
  assert.equal(useExtensions.getState().install, null);
  folders.get("/tmp/rs/ext").digest = "d-2";
  assert.equal(await reloadFromSource(windowId, "", ext), true);
  assert.equal(useExtensions.getState().install?.status, "ready");
  assert.equal(reloads.length, 1, "a changed folder isn't reloaded until the user adds it");
  cancelInstall();
});

test("removing a managed extension asks Ardia to delete its copy; one loaded from its own folder doesn't", async () => {
  const { list, uninstalls } = await setup();
  list.push(row("managed", { path: "/data/live/managed", managedSource: "/src/managed" }), row("direct", { path: "/src/direct" }));
  const yes = async () => ({ confirmed: true });
  await removeExtension("", list[0], undefined, () => true, yes);
  await removeExtension("", list[0], undefined, () => true, yes);
  assert.deepEqual(uninstalls, [
    { id: "managed", managed: "/data/live/managed" },
    { id: "direct", managed: undefined },
  ]);
});
