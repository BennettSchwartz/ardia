import assert from "node:assert/strict";
import { test } from "node:test";

let timers = [];
globalThis.setTimeout = (fn, ms) => (timers.push({ fn, ms }), timers.length);
globalThis.clearTimeout = () => {};
globalThis.__DEV__ = false;

const folder = new Map();
const calls = { unlock: 0, openLocal: 0, chainStatus: 0, read: 0 };
const hold = { unlock: null, read: null };
let unlockAnswer = true;
let chainFails = false;
let duringRead = null;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => "devP",
    deviceName: () => "Test PC",
    createPhrase: async () => true,
    createChain: async () => {},
    unlock: async () => {
      calls.unlock++;
      if (hold.unlock) await new Promise(() => {});
      return unlockAnswer;
    },
    forget: async () => {},
    chainStatus: async () => {
      calls.chainStatus++;
      if (chainFails) throw new Error("The sync folder went away");
      return "ok";
    },
    write: async (_folder, scope, payload) => {
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      calls.read++;
      duringRead?.();
      if (hold.read) await new Promise(() => {});
      const here = [...folder].filter(([, f]) => f.scope === scope);
      const files = here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload }));
      return { files, pending: [], damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => {
      calls.openLocal++;
      return sealed.startsWith("sealed:") ? sealed.slice(7) : null;
    },
    readPasswords: async () => null,
  },
};

const shell = await import("../../test-native/index.ts");
const { reloadLaunchConfigForTests } = await import("../../platform/launchConfig.ts");
const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
const { takeSyncPauseCounts } = await import("../telemetry/syncPauseCounts.ts");
const { syncFiles } = await import("./syncFiles.ts");
const { useBrowser } = await import("../browser/store.ts");
const quit = await import("../app/quit.ts");
const S = () => useBrowser.getState();

setConsentPeriod(true, "sync-pause-test");

const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
};
const docOnDisk = () => JSON.parse(shell.docs.get("sync.json"));
const syncFileNames = () => [...shell.docs.keys()].filter((name) => name.startsWith("sync-")).sort();
const sealedFiles = () => Object.fromEntries(syncFileNames().map((name) => [name, shell.docs.get(name)]));

const reads = [];
const writes = [];
shell.docs.get = function (name) {
  reads.push(name);
  return Map.prototype.get.call(this, name);
};
shell.docs.set = function (name, contents) {
  writes.push(name);
  return Map.prototype.set.call(this, name, contents);
};

function recovered(on) {
  shell.launch.recoveredStart = on;
  reloadLaunchConfigForTests();
}

function quiet() {
  for (const key in calls) calls[key] = 0;
  hold.unlock = hold.read = null;
  unlockAnswer = true;
  chainFails = false;
  duringRead = null;
  timers = [];
  reads.length = 0;
  writes.length = 0;
  takeSyncPauseCounts();
}

let instances = 0;
const engineInstance = () => import(`./engine.ts?pause${++instances}`);

async function syncedProfile() {
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
  shell.docs.clear();
  folder.clear();
  recovered(false);
  const first = await engineInstance();
  first.startSync();
  assert.ok("ok" in (await first.turnOnSync("/sync")));
  S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
  await first.syncNow();
  await quit.finishQuitSaves(5_000);
  S().addBookmark({ profileId: "default", url: "https://two.example/", title: "Two" });
  await first.syncNow();
  await settle();
  const disk = new Map(shell.docs);
  const shared = new Map(folder);
  const seqs = docOnDisk().seqs;
  assert.ok(Object.values(seqs).some((seq) => seq > 0), "the profile has written batches, so sync.json carries seqs");
  assert.ok(shell.docs.get("sync-state.nns"), "and a sealed state");
  assert.ok(syncFileNames().some((name) => /^sync-journal-\d+\.nns$/.test(name)), "and journal parts");
  await first.stopSync();
  folder.clear();
  for (const [id, file] of shared) folder.set(id, file);
  return { disk, seqs };
}

function restore(disk) {
  shell.docs.clear();
  for (const [name, contents] of disk) Map.prototype.set.call(shell.docs, name, contents);
}

const retire = (engine) => engine.stopSync();

async function pausedStart(disk, { recoveredStart = true } = {}) {
  restore(disk);
  recovered(recoveredStart);
  quiet();
  const engine = await engineInstance();
  engine.startSync();
  await settle();
  return engine;
}

async function timersRun() {
  const due = timers;
  timers = [];
  for (const { fn } of due) fn();
  await settle();
}

test("a recovered start with sync on loads nothing, schedules no cycle, and records the pause beside the seqs it read", async () => {
  const { disk, seqs } = await syncedProfile();
  const sealedBefore = Object.fromEntries([...disk].filter(([name]) => name.startsWith("sync-")));
  const engine = await pausedStart(disk);

  assert.equal(engine.useSync.getState().status, "paused");
  assert.equal(engine.useSync.getState().enabled, true);
  assert.equal(calls.unlock, 0, "the sync key isn't unlocked");
  assert.equal(calls.openLocal, 0, "nothing sealed is opened");
  assert.deepEqual(reads.filter((name) => name.startsWith("sync")), ["sync.json"], "only sync.json is read");
  assert.deepEqual(writes.filter((name) => name.startsWith("sync")), ["sync.json"], "only sync.json is written");
  assert.equal(docOnDisk().pausedByGuard, true);
  assert.deepEqual(docOnDisk().seqs, seqs, "the seqs read from disk are kept");
  assert.deepEqual(sealedFiles(), sealedBefore, "the state and journal parts are untouched");
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 1, sync_resumes: 0, sync_resumes_completed: 0 });

  S().addBookmark({ profileId: "default", url: "https://three.example/", title: "Three" });
  await engine.syncNow();
  assert.deepEqual(engine.sendTargets("default"), []);
  await timersRun();
  assert.equal(calls.chainStatus, 0, "no cycle runs, from a timer, an edit or Sync Now");
  assert.equal(calls.unlock, 0);
  assert.deepEqual(sealedFiles(), sealedBefore);
  assert.deepEqual(docOnDisk().seqs, seqs);
});

test("a later start that isn't recovered stays paused while the pause is on disk", async () => {
  const { disk, seqs } = await syncedProfile();
  await pausedStart(disk);
  const later = await pausedStart(new Map(shell.docs), { recoveredStart: false });
  assert.equal(later.useSync.getState().status, "paused");
  assert.equal(calls.unlock, 0);
  assert.equal(calls.openLocal, 0);
  await timersRun();
  assert.equal(calls.chainStatus, 0);
  assert.equal(docOnDisk().pausedByGuard, true);
  assert.deepEqual(docOnDisk().seqs, seqs);
  assert.deepEqual(takeSyncPauseCounts().sync_paused_by_launch_guard, 0, "a start the guard didn't recover isn't counted as paused by it");
});

test("quitting while paused writes neither the state nor a journal part, and keeps the seqs", async () => {
  const { disk, seqs } = await syncedProfile();
  await pausedStart(disk);
  const before = sealedFiles();
  const docBefore = shell.docs.get("sync.json");
  writes.length = 0;
  quit.setQuitting(true);
  try {
    await quit.finishQuitSaves(5_000);
    await settle();
  } finally {
    quit.setQuitting(false);
  }
  assert.deepEqual(writes, [], "nothing is written at quit");
  assert.deepEqual(sealedFiles(), before);
  assert.equal(shell.docs.get("sync.json"), docBefore);
  assert.deepEqual(docOnDisk().seqs, seqs);
});

test("Resume unlocks, loads, runs one cycle, and clears the pause only after that cycle", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  let pausedDuringCycle = null;
  duringRead = () => (pausedDuringCycle ??= docOnDisk().pausedByGuard === true);

  await engine.resumeSync();

  assert.equal(calls.unlock, 1);
  assert.ok(calls.openLocal > 0, "the saved state is loaded");
  assert.equal(calls.chainStatus, 1, "one cycle");
  assert.equal(pausedDuringCycle, true, "the pause is still on disk while the cycle runs");
  assert.equal(engine.useSync.getState().status, "updated");
  assert.equal(docOnDisk().pausedByGuard, undefined, "and cleared once it finished");
  assert.ok(timers.some(({ ms }) => ms === 15_000), "sync carries on as usual");
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 1, sync_resumes: 1, sync_resumes_completed: 1 });
  await retire(engine);
});

test("a Resume whose cycle fails stays paused, says why, and runs nothing more", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  chainFails = true;
  await engine.resumeSync();
  assert.equal(engine.useSync.getState().status, "paused");
  assert.equal(engine.useSync.getState().error, "The sync folder went away");
  assert.equal(docOnDisk().pausedByGuard, true);
  const cycles = calls.chainStatus;
  chainFails = false;
  await timersRun();
  assert.equal(calls.chainStatus, cycles, "no cycle follows on its own");
  quit.setQuitting(true);
  const before = sealedFiles();
  try {
    await quit.finishQuitSaves(5_000);
    await settle();
  } finally {
    quit.setQuitting(false);
  }
  assert.deepEqual(sealedFiles(), before, "and quitting writes no state");
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 1, sync_resumes: 1, sync_resumes_completed: 0 });
});

test("a Resume whose unlock fails stays paused, says why, and loads nothing", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  unlockAnswer = false;
  await engine.resumeSync();
  assert.equal(engine.useSync.getState().status, "paused");
  assert.match(engine.useSync.getState().error ?? "", /couldn’t unlock/);
  assert.equal(calls.openLocal, 0);
  assert.equal(calls.chainStatus, 0);
  assert.equal(docOnDisk().pausedByGuard, true);
});

test("a crash during Resume leaves the next start paused", async () => {
  const { disk } = await syncedProfile();
  const engine = await pausedStart(disk);
  hold.read = true;
  void engine.resumeSync();
  await settle();
  assert.equal(calls.read > 0, true, "the cycle is under way");
  assert.equal(docOnDisk().pausedByGuard, true);
  const afterCrash = await pausedStart(new Map(shell.docs), { recoveredStart: false });
  assert.equal(afterCrash.useSync.getState().status, "paused");
  assert.equal(calls.unlock, 0);
  assert.equal(calls.openLocal, 0);
});

test("with sync off a recovered start changes nothing", async () => {
  S().hydrate({});
  shell.docs.clear();
  const engine = await pausedStart(new Map());
  assert.equal(engine.useSync.getState().status, "off");
  assert.equal(shell.docs.get("sync.json"), undefined);
  assert.deepEqual(writes.filter((name) => name.startsWith("sync")), []);
  assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 0, sync_resumes: 0, sync_resumes_completed: 0 });
  await engine.resumeSync();
  assert.equal(calls.unlock, 0);
});

test("with sharing off nothing is counted", async () => {
  const { disk } = await syncedProfile();
  setConsentPeriod(false, null);
  try {
    const engine = await pausedStart(disk);
    await engine.resumeSync();
    assert.equal(engine.useSync.getState().status, "updated");
    assert.deepEqual(takeSyncPauseCounts(), { sync_paused_by_launch_guard: 0, sync_resumes: 0, sync_resumes_completed: 0 });
    await retire(engine);
  } finally {
    setConsentPeriod(true, "sync-pause-test");
  }
});

test("sync.json saved before the scopes are loaded keeps the seqs it was read with", async () => {
  shell.docs.clear();
  Map.prototype.set.call(shell.docs, "sync.json", JSON.stringify({ enabled: true, folder: "/sync", deviceId: "devA", seqs: { app: 4, "p:x": 7 }, v: 1 }));
  let doc = null;
  const files = syncFiles(() => doc);
  doc = files.read();
  doc.pausedByGuard = true;
  files.save();
  await files.checkpoint();
  await settle();
  assert.deepEqual(docOnDisk().seqs, { app: 4, "p:x": 7 });
  assert.equal(docOnDisk().pausedByGuard, true);
  assert.equal(shell.docs.get("sync-state.nns"), undefined);
});
