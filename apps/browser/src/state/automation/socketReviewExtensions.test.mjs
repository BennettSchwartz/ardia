import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { useExtensions, confirmInstall, cancelInstall } = await import("../extensions/actions.ts");
const { nextInstallKey } = await import("../extensions/store.ts");
const { folderProblem } = await import("./extensionFolders.ts");
const stub = await import("../../test-native/index.ts");
const { extensionWorld, row } = await import("./fixtures/extensionWorld.mjs");

const S = () => useBrowser.getState();
after(() => S().updateSettings({ cliControl: false }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;
const CONNECTION = 61;

function send(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: CONNECTION, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  return async () => {
    const mine = () => stub.controlSocket.replies.slice(before).find((r) => r.connection === CONNECTION && JSON.parse(r.line).id === id);
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
const code = async (method, params) => (await call(method, params)).error?.code;
const sheet = async () => {
  for (let i = 0; i < 50 && useExtensions.getState().install?.status !== "ready"; i++) await tick();
  return useExtensions.getState().install;
};

async function setup() {
  cancelInstall();
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  return { windowId, ...extensionWorld() };
}

test("folder paths: system and home folders and dot segments are refused before anything is read", () => {
  for (const bad of ["/", "/System", "/System/Library/Extensions", "/Users/someone", "/Users/someone/", "/tmp", "/usr/lib/x", "/Users/a/../b/ext", "relative/ext", "/a/./b"]) assert.ok(folderProblem(bad), bad);
  for (const good of ["/Users/someone/dev/ext", "/tmp/one/ext", "/private/tmp/x/ext", "/Volumes/Work/ext"]) assert.equal(folderProblem(good), null, good);
});

test("a second folder request is refused while a sheet shows, and a sheet confirms only its own request", async () => {
  const { folders, list } = await setup();
  folders.set("/tmp/a/ext", { id: "aaa", digest: "d-a" });
  folders.set("/tmp/b/ext", { id: "bbb", digest: "d-b" });
  const first = send("extensions.install", { folder: "/tmp/a/ext" });
  const shown = await sheet();
  assert.equal(shown.pkg.path, "/tmp/a/ext");
  assert.equal(await code("extensions.install", { folder: "/tmp/b/ext" }), "refused", "one sheet at a time");
  assert.equal(useExtensions.getState().install.key, shown.key, "the first sheet is still the one showing");

  const other = { ...shown, key: nextInstallKey(), pkg: { ...shown.pkg, name: "bbb", path: "/tmp/b/ext", digest: "d-b" } };
  useExtensions.setState({ install: other });
  await confirmInstall(shown.key);
  assert.equal(list.length, 0, "a click on the old sheet doesn't add whatever replaced it");
  assert.deepEqual((await first()).result, { installed: false, extensions: [] });
  cancelInstall(other.key);
});

test("a folder edited after the sheet showed it installs the copy the sheet showed", async () => {
  const { folders, list, installs } = await setup();
  folders.set("/tmp/c/ext", { id: "ccc", digest: "d-c1", version: "1.0" });
  const pending = send("extensions.install", { folder: "/tmp/c/ext" });
  const shown = await sheet();
  assert.ok(shown.pkg.staged, "the sheet describes Ardia's own copy");
  Object.assign(folders.get("/tmp/c/ext"), { digest: "d-c2", version: "2.0" });
  await confirmInstall(shown.key);
  const reply = await pending();
  assert.ok(!reply.error, JSON.stringify(reply.error));
  assert.deepEqual(installs.at(-1), { path: "/tmp/c/ext", staged: shown.pkg.staged, id: "ccc", version: "1.0" });
  assert.equal(list.find((x) => x.id === "ccc").version, "1.0", "what the sheet showed, not the edit");
});

test("cancelling a folder's sheet throws Ardia's copy away", async () => {
  const { folders } = await setup();
  folders.set("/tmp/g/ext", { id: "ggg", digest: "d-g" });
  const pending = send("extensions.install", { folder: "/tmp/g/ext" });
  const shown = await sheet();
  cancelInstall(shown.key);
  assert.deepEqual((await pending()).result, { installed: false, extensions: [] });
  assert.ok(stub.discardedStages.includes(shown.pkg.staged));
});

test("the reply names the request's own extension, a reinstall counts as installed, and a closed window settles it", async () => {
  const { folders, list, windowId } = await setup();
  folders.set("/tmp/d/ext", { id: "ddd", digest: "d-d" });
  const pending = send("extensions.install", { folder: "/tmp/d/ext" });
  const shown = await sheet();
  list.push(row("unrelated"));
  await confirmInstall(shown.key);
  assert.deepEqual((await pending()).result.extensions.map((x) => x.id), ["ddd"], "not the extension installed alongside");

  const again = send("extensions.install", { folder: "/tmp/d/ext" });
  await confirmInstall((await sheet()).key);
  const reinstalled = (await again()).result;
  assert.equal(reinstalled.installed, true);
  assert.deepEqual(reinstalled.extensions.map((x) => x.id), ["ddd"]);

  const orphan = send("extensions.install", { folder: "/tmp/d/ext" });
  assert.equal((await sheet()).windowId, windowId);
  S().closeWindow(windowId);
  const closed = await orphan();
  assert.equal(closed.error?.code, "failed");
  assert.match(closed.error.message, /closed/);
  assert.equal(useExtensions.getState().install, null);
});

test("turning control off or losing the profile while the folder is read shows no sheet", async () => {
  const { folders, gates } = await setup();
  folders.set("/tmp/e/ext", { id: "eee", digest: "d-e" });
  let open;
  gates.inspect = new Promise((resolve) => (open = resolve));
  const pending = send("extensions.install", { folder: "/tmp/e/ext" });
  await tick();
  S().updateSettings({ cliControl: false });
  open();
  assert.equal((await pending()).error?.code, "failed");
  assert.equal(useExtensions.getState().install, null);
  S().updateSettings({ cliControl: true });
  for (let i = 0; i < 20; i++) await tick();

  const work = await ok("profiles.create", { name: "Work" });
  gates.inspect = new Promise((resolve) => (open = resolve));
  const lost = send("extensions.install", { folder: "/tmp/e/ext", profile: work.id });
  await tick();
  S().deleteProfile(work.id);
  open();
  assert.equal((await lost()).error?.code, "no_window");
  assert.equal(useExtensions.getState().install, null);
  gates.inspect = null;

  folders.set("/tmp/f/ext", { id: "fff" });
  assert.equal(await code("extensions.install", { folder: "/tmp/f/ext" }), "refused", "a package without a digest can't be pinned");
  assert.equal(await code("extensions.install", { folder: "/Users/someone" }), "bad_request");
});

test("the Web Store path opens no tab once control is off", async () => {
  await setup();
  const tabs = Object.keys(S().tabs).length;
  const pending = send("extensions.install", { webStore: "abcdefghijklmnopabcdefghijklmnop" });
  S().updateSettings({ cliControl: false });
  assert.equal((await pending()).error?.code, "failed");
  assert.equal(Object.keys(S().tabs).length, tabs);
});

test("configure: specific sites with none granted answers with what Chromium reports, and a refused field changes nothing", async () => {
  const { list } = await setup();
  list.push(row("site", { siteAccess: "ON_ALL_SITES" }));
  await ok("extensions.list");
  const narrowed = await ok("extensions.configure", { id: "site", siteAccess: "specificSites" });
  assert.deepEqual([narrowed.siteAccess, narrowed.sites], ["ON_CLICK", []]);
  list[0].sites = ["https://a.example/*"];
  assert.equal((await ok("extensions.configure", { id: "site", siteAccess: "specificSites" })).siteAccess, "ON_SPECIFIC_SITES");

  list[0].lockedSites = true;
  await ok("extensions.list");
  assert.equal(await code("extensions.configure", { id: "site", siteAccess: "allSites", incognito: true }), "failed");
  assert.equal(list[0].incognito, false, "Allow in Incognito didn't change when site access was refused");
});
