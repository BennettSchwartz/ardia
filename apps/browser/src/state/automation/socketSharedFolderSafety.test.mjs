import assert from "node:assert/strict";
import { test } from "node:test";

const created = [];
const discarded = [];
const applied = [];
const aliases = new Map([["/scratch/link", "/scratch/Real"]]);
const missing = new Set(["/scratch/Gone"]);
const listings = new Map();
const holds = new Map();
const empty = { exists: true, root: { entries: [], manifest: null, manifestPending: false } };

function hold(name) {
  let release;
  holds.set(name, new Promise((resolve) => (release = resolve)));
  return () => release();
}
async function passGate(name) {
  const gate = holds.get(name);
  if (!gate) return;
  holds.delete(name);
  await gate;
}

const inodeOf = (path) => [...path].reduce((n, c) => n + c.charCodeAt(0), 0);
const identityOf = (path) => ({ device: 7, inode: inodeOf(path) });
const REFUSED = new Set(["/", "/System", "/Users", "/Library"]);
const reads = [];
const resolved = [];
const madePaths = new Set();

globalThis.acTestNativeModules = {
  ArdiaSharedFolders: {
    location: () => ({ path: "/scratch/Ardia Shared", iCloudAvailable: true, iCloudPath: "/scratch" }),
    read: async (path, identity) => (reads.push([path, identity]), await passGate("read"), listings.get(path) ?? empty),
    apply: async (path, ops) => (applied.push([path, JSON.parse(ops)]), { conflicts: [] }),
    create: async (parent, parentIdentity, name) => {
      await passGate("create");
      created.push([parent, parentIdentity, name]);
      let path = `${parent}/${name}`;
      for (let n = 2; madePaths.has(path); n++) path = `${parent}/${name} ${n}`;
      madePaths.add(path);
      return { path, ...identityOf(path) };
    },
    resolve: async (given) => {
      resolved.push(given);
      const path = given.replace(/\/+$/, "") || "/";
      const real = aliases.get(path) ?? path;
      if (REFUSED.has(real) || /^\/Users\/[^/]+$/.test(real)) throw Object.assign(new Error(`${real} is a system or home folder; pick a folder inside it.`), { code: "ERR_SHARED_FOLDER_REFUSED" });
      if (missing.has(real)) throw new Error(`There's no folder at ${path}.`);
      return { path: real, ...identityOf(real) };
    },
    discard: async (path, identity) => (discarded.push([path, identity]), true),
    watch: () => {},
    addListener: () => ({ remove() {} }),
  },
};

const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { startPersistence } = await import("../session/persist.ts");
const { bindFolder, boundFolders, sharedFolderOf, setFolderSync } = await import("../sharedFolders/store.ts");
const { shareFolder } = await import("../sharedFolders/actions.ts");
const { pinKeyOf } = await import("../browser/model.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

function send(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 31, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  return (async () => {
    for (let i = 0; i < 4000; i++) {
      const reply = stub.controlSocket.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
      if (reply) return reply;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`no reply to ${method}`);
  })();
}
const ok = async (method, params) => {
  const reply = await send(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

let persisting = false;
async function setup(name) {
  if (!persisting) (startPersistence(), (persisting = true));
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://home.example/" });
  const tab = S().newTab(windowId, { url: `https://${name.toLowerCase()}.example/`, background: true });
  const group = S().groupTabs([tab], { pinned: true, name });
  return { windowId, tab, group, profileId: S().groups[group].profileId, key: pinKeyOf(S().groups[group]) };
}

test("control switched off while share makes the folder: nothing is bound and the new folder is removed", async () => {
  const { group, profileId, key } = await setup("Offline");
  const release = hold("create");
  const pending = send("sharedFolders.share", { group });
  await settle();
  S().updateSettings({ cliControl: false });
  release();
  const reply = await pending;
  assert.equal(reply.error?.code, "failed");
  assert.equal(sharedFolderOf(profileId, key), undefined, "no binding after control went off");
  assert.deepEqual(discarded.at(-1), ["/scratch/Ardia Shared/Offline", identityOf("/scratch/Ardia Shared/Offline")]);
});

test("control switched off during a socket sync: the round writes no files", async () => {
  const { group, profileId, key } = await setup("Quiet");
  await ok("sharedFolders.share", { group });
  const writes = applied.length;
  S().newTab(S().groups[group].windowId, { url: "https://more.example/", background: true });
  const release = hold("read");
  const pending = send("sharedFolders.sync", { group });
  await settle();
  S().updateSettings({ cliControl: false });
  release();
  assert.equal((await pending).error?.code, "failed");
  await settle();
  assert.equal(applied.length, writes, "no write after control went off");
  assert.ok(sharedFolderOf(profileId, key));
});

test("add binds the canonical path once, whatever the spelling, and refuses / and system folders", async () => {
  const { windowId } = await setup("Spelling");
  const first = await ok("sharedFolders.add", { path: "/scratch/link/", window: windowId });
  assert.equal(first.path, "/scratch/Real");
  const second = await ok("sharedFolders.add", { path: "/scratch/Real", window: windowId });
  assert.deepEqual(second.groups, first.groups, "two spellings of one folder make one binding");
  assert.equal(boundFolders().filter((b) => b.folder.path === "/scratch/Real").length, 1);
  assert.deepEqual(boundFolders().find((b) => b.folder.path === "/scratch/Real").folder.identity, identityOf("/scratch/Real"));
  const groups = Object.keys(S().groups).length;
  assert.equal((await send("sharedFolders.add", { path: "/" })).error?.code, "refused");
  assert.equal((await send("sharedFolders.add", { path: "/Users" })).error?.code, "refused");
  assert.equal(Object.keys(S().groups).length, groups, "no group for a refused path");
});

test("add verifies the folder first: a missing or unreadable folder adds nothing", async () => {
  const { windowId } = await setup("Verify");
  const groups = Object.keys(S().groups).length;
  const bound = boundFolders().length;
  const gone = await send("sharedFolders.add", { path: "/scratch/Gone", window: windowId });
  assert.equal(gone.error?.code, "bad_request");
  listings.set("/scratch/Locked", { exists: false, error: "Can’t open “Locked”: Permission denied" });
  const locked = await send("sharedFolders.add", { path: "/scratch/Locked", window: windowId });
  assert.equal(locked.error?.code, "bad_request");
  assert.match(locked.error.message, /Permission denied/);
  listings.set("/scratch/Huge", { exists: false, error: "“Huge” holds more than 20000 items or 32 MB of links; Ardia syncs smaller folders." });
  assert.match((await send("sharedFolders.add", { path: "/scratch/Huge", window: windowId })).error?.message ?? "", /more than/);
  assert.equal(Object.keys(S().groups).length, groups);
  assert.equal(boundFolders().length, bound);
});

test("overlapping shares of one group make one folder; a group removed while its folder is made isn't bound", async () => {
  const { group, profileId, key } = await setup("Twice");
  const release = hold("create");
  const made = created.length;
  const one = send("sharedFolders.share", { group });
  const two = send("sharedFolders.share", { group });
  await settle();
  release();
  const [a, b] = await Promise.all([one, two]);
  assert.ok(!a.error && !b.error, JSON.stringify([a.error, b.error]));
  assert.equal(created.length - made, 1, "one folder made");
  assert.equal(a.result.path, b.result.path);
  assert.equal(sharedFolderOf(profileId, key).path, a.result.path);

  const other = await setup("Vanish");
  const release2 = hold("create");
  const pending = send("sharedFolders.share", { group: other.group });
  await settle();
  S().ungroup(other.group);
  release2();
  assert.equal((await pending).error?.code, "no_window");
  assert.equal(sharedFolderOf(other.profileId, other.key), undefined);
  assert.deepEqual(discarded.at(-1), ["/scratch/Ardia Shared/Vanish", identityOf("/scratch/Ardia Shared/Vanish")]);
});

test("stop while a sync runs: the sync answers with a clear error instead of a crash", async () => {
  const { group } = await setup("Stopping");
  await ok("sharedFolders.share", { group });
  const release = hold("read");
  const pending = send("sharedFolders.sync", { group });
  await settle();
  await ok("sharedFolders.stop", { group });
  release();
  const reply = await pending;
  assert.equal(reply.error?.code, "failed");
  assert.match(reply.error.message, /stopped syncing/);
});

test("share reports a failed initial sync instead of handing out the folder's URL", async () => {
  const { group, profileId, key } = await setup("Broken");
  listings.set("/scratch/Ardia Shared/Broken", { exists: false, error: "Can’t open “Broken”: Operation not permitted" });
  const reply = await send("sharedFolders.share", { group });
  assert.equal(reply.error?.code, "failed");
  assert.match(reply.error.message, /couldn't be synced yet: Can’t open/);
  assert.equal(reply.result, undefined);
  setFolderSync(profileId, key, { state: "synced", error: null });
});

test("share makes its folder in the checked parent and binds the identity create returned, without resolving the new folder", async () => {
  const { group, profileId, key } = await setup("Parented");
  aliases.set("/scratch/parent-link", "/scratch/Parent");
  const shown = await ok("sharedFolders.share", { group, parent: "/scratch/parent-link/" });
  assert.deepEqual(created.at(-1), ["/scratch/Parent", identityOf("/scratch/Parent"), "Parented"]);
  assert.equal(shown.path, "/scratch/Parent/Parented");
  assert.deepEqual(sharedFolderOf(profileId, key).identity, identityOf("/scratch/Parent/Parented"));
  assert.ok(!resolved.includes("/scratch/Parent/Parented"), "the new folder isn't resolved by path in a second call");
  assert.equal((await send("sharedFolders.share", { group: (await setup("Rooted")).group, parent: "/" })).error?.code, "refused");
});

test("a legacy binding is upgraded to its canonical path and identity the first time it's used, and add finds it by identity", async () => {
  const { group, profileId, key, windowId } = await setup("Legacy");
  aliases.set("/scratch/legacy-link", "/scratch/Legacy Real");
  bindFolder(profileId, key, "/scratch/legacy-link");
  const groups = Object.keys(S().groups).length;
  const again = await ok("sharedFolders.add", { path: "/scratch/Legacy Real", window: windowId });
  assert.deepEqual(again.groups, [group], "the real path finds the legacy binding");
  assert.equal(Object.keys(S().groups).length, groups, "no second group");
  assert.equal(sharedFolderOf(profileId, key).path, "/scratch/Legacy Real");
  assert.deepEqual(sharedFolderOf(profileId, key).identity, identityOf("/scratch/Legacy Real"));

  const other = await setup("Legacy Share");
  bindFolder(other.profileId, other.key, "/scratch/legacy-share-link");
  aliases.set("/scratch/legacy-share-link", "/scratch/Legacy Share Real");
  reads.length = 0;
  await ok("sharedFolders.share", { group: other.group });
  assert.deepEqual(reads.at(-1), ["/scratch/Legacy Share Real", identityOf("/scratch/Legacy Share Real")], "share syncs with the identity");
});

test("the sidebar and the socket sharing one unbound group make one binding; the loser discards its own folder", async () => {
  const { group, windowId, profileId, key } = await setup("Race");
  const release = hold("create");
  const sidebar = shareFolder(windowId, group);
  await settle();
  const socket = await ok("sharedFolders.share", { group });
  release();
  await sidebar;
  await settle();
  assert.equal(sharedFolderOf(profileId, key).path, socket.path, "the socket's binding stands");
  const lost = created.filter(([, , name]) => name === "Race").length;
  assert.equal(lost, 2, "both made a folder");
  const loser = [...madePaths].find((p) => p.startsWith("/scratch/Ardia Shared/Race") && p !== socket.path);
  assert.deepEqual(discarded.at(-1), [loser, identityOf(loser)], "the sidebar removed the folder it made, by identity");
});
