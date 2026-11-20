import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, loadSession, resumePersistence, startPersistence } = await import("./persist.ts");
const { parsePinBackups, PINS_BACKUP_DOCUMENT } = await import("./pinGuard.ts");
const { takeSessionWrites } = await import("../telemetry/sessionWrites.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  flushPersistence();
  for (let i = 0; i < 4; i++) {
    await turn();
    flushPersistence();
  }
}
const sessionUrls = () => JSON.parse(stub.docs.get("session.json")).tabs.map((t) => t.url);
const backups = () => parsePinBackups(stub.docs.get(PINS_BACKUP_DOCUMENT));
const pinsIn = (w, profileId) => S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.profileId === profileId && t.pin).map((t) => t.pinnedUrl ?? t.url);
const foldersIn = (w, profileId) =>
  Object.values(S().groups).filter((g) => g.pinned && g.windowId === w && g.profileId === profileId).map((g) => [g.name, g.tabIds.map((id) => S().tabs[id].url)]);

function workShownInSecondWindowOnly() {
  const a = S().createWindow({ url: "https://a1.com" });
  const b = S().createWindow({ url: "https://b1.com" });
  S().updateSettings({ shareTabsAcrossWindows: true });
  const work = S().createProfile({ name: "Work" });
  const pin = S().newTab(b, { url: "https://pin.com", profileId: work, background: true });
  const inFolder = S().newTab(b, { url: "https://folder.com", profileId: work, background: true });
  S().newTab(b, { url: "https://loose.com", profileId: work, background: true });
  S().pinTabs([pin], true);
  S().groupTabs([inFolder], { pinned: true, name: "Folder" });
  return { a, b, work };
}

test("closing the only window that showed a profile keeps its pins on disk, and they come back after a relaunch (#2175)", () => {
  stub.docs.clear();
  const stop = startPersistence();
  const { a, b, work } = workShownInSecondWindowOnly();
  flushPersistence();
  S().closeWindow(b);
  flushPersistence();
  stop();
  const saved = JSON.parse(stub.docs.get("session.json"));
  const keptUrls = [...saved.tabs.filter((t) => t.profileId === work).map((t) => t.url), ...(saved.parkedPins[work]?.tabs ?? []).map((t) => t.url)];
  assert.ok(keptUrls.includes("https://pin.com"), "the pinned tab is in session.json");
  assert.ok(keptUrls.includes("https://folder.com"), "the folder's tab is in session.json");
  S().hydrate(loadSession());
  S().switchProfile(a, work);
  assert.deepEqual(pinsIn(a, work), ["https://pin.com"]);
  assert.deepEqual(foldersIn(a, work), [["Folder", ["https://folder.com"]]]);
  assert.equal(backups().length, 0, "nothing was dropped, so no backup");
});

test("a save that drops pins keeps them in pins-backup.json, ready to park again", async () => {
  stub.docs.clear();
  takeSessionWrites();
  const stop = startPersistence();
  const w = S().createWindow({ url: "https://a1.com" });
  const pin = S().newTab(w, { url: "https://pin.com", background: true });
  const inFolder = S().newTab(w, { url: "https://folder.com", background: true });
  S().pinTabs([pin], true);
  S().groupTabs([inFolder], { pinned: true, name: "Folder" });
  const profileId = S().windows[w].profileId;
  flushPersistence();
  const s = S();
  const gone = new Set([pin, inFolder]);
  useBrowser.setState({
    tabs: Object.fromEntries(Object.entries(s.tabs).filter(([id]) => !gone.has(id))),
    groups: Object.fromEntries(Object.entries(s.groups).filter(([, g]) => !g.pinned)),
    windows: { ...s.windows, [w]: { ...s.windows[w], tabIds: s.windows[w].tabIds.filter((id) => !gone.has(id)) } },
  });
  await settle();
  stop();
  const [kept] = backups();
  assert.deepEqual(kept.dropped, { [profileId]: 3 }, "the pin, the folder and its tab");
  const pins = kept.pins[profileId];
  assert.deepEqual(pins.tabs.map((t) => t.url).sort(), ["https://folder.com", "https://pin.com"]);
  assert.deepEqual(pins.groups.map((g) => g.name), ["Folder"]);
  const counts = takeSessionWrites();
  assert.equal(counts.session_pin_backups, 1);
  assert.equal(counts.session_pins_backed_up, 3);
  S().closeWindow(w);
  useBrowser.setState({ parkedPins: { ...S().parkedPins, [profileId]: pins } });
  const n = S().createWindow({ url: "https://b1.com" });
  assert.ok(pinsIn(n, profileId).includes("https://pin.com"), "parking the backup brings the pin back");
  assert.deepEqual(foldersIn(n, profileId), [["Folder", ["https://folder.com"]]]);
});

test("closing a window whose pins stay in another window or the park, or deleting a profile, keeps no backup", () => {
  stub.docs.clear();
  const stop = startPersistence();
  const a = S().createWindow({ url: "https://a1.com" });
  const pin = S().newTab(a, { url: "https://pin.com", background: true });
  S().pinTabs([pin], true);
  const b = S().createWindow({ url: "https://b1.com" });
  const work = S().createProfile({ name: "Work" });
  const workPin = S().newTab(b, { url: "https://work-pin.com", profileId: work, background: true });
  S().pinTabs([workPin], true);
  flushPersistence();
  S().closeWindow(b);
  flushPersistence();
  assert.equal(backups().length, 0, "the closed window's pins live on in the open window or parked");
  S().deleteProfile(work);
  flushPersistence();
  stop();
  assert.equal(backups().filter((x) => x.profileId === work).length, 0, "a deleted profile's pins aren't backed up");
});

function dropPins(ids) {
  const s = S();
  const gone = new Set(ids);
  useBrowser.setState({
    tabs: Object.fromEntries(Object.entries(s.tabs).filter(([id]) => !gone.has(id))),
    windows: Object.fromEntries(Object.entries(s.windows).map(([id, w]) => [id, { ...w, tabIds: w.tabIds.filter((t) => !gone.has(t)) }])),
  });
}

test("the backup keeps two pins of the same page that parking would merge", async () => {
  stub.docs.clear();
  const stop = startPersistence();
  const w = S().createWindow({ url: "https://a1.com" });
  const one = S().newTab(w, { url: "https://example.com/page", background: true });
  const two = S().newTab(w, { url: "https://example.com/page#notes", background: true });
  S().pinTabs([one, two], true);
  const profileId = S().windows[w].profileId;
  flushPersistence();
  dropPins([one, two]);
  await settle();
  stop();
  const [kept] = backups();
  assert.deepEqual(kept.pins[profileId].tabs.map((t) => t.url).sort(), ["https://example.com/page", "https://example.com/page#notes"]);
});

function onePin() {
  stub.docs.clear();
  const stop = startPersistence();
  const w = S().createWindow({ url: "https://a1.com" });
  const pin = S().newTab(w, { url: "https://pin.com", background: true });
  S().pinTabs([pin], true);
  flushPersistence();
  assert.ok(sessionUrls().includes("https://pin.com"));
  return { stop, w, pin, profileId: S().windows[w].profileId };
}

test("when the session write fails after the backup landed, the next save writes it and the backup isn't repeated", async () => {
  const { stop, w, pin, profileId } = onePin();
  stub.refusedWrites.on = true;
  try {
    dropPins([pin]);
    await settle();
  } finally {
    stub.refusedWrites.on = false;
  }
  assert.equal(backups().length, 1, "the backup landed");
  assert.ok(sessionUrls().includes("https://pin.com"), "the session write was refused");
  S().newTab(w, { url: "https://other.com", background: true });
  await settle();
  stop();
  const kept = backups();
  assert.equal(kept.length, 1, "not backed up twice");
  assert.deepEqual(kept[0].pins[profileId].tabs.map((t) => t.url), ["https://pin.com"]);
  assert.ok(!sessionUrls().includes("https://pin.com"));
});


test("a failing backup write holds the session write that drops pins, and both land once the backup does", async () => {
  const { stop, pin, profileId } = onePin();
  const realNow = Date.now;
  stub.refusedSaves.on = true;
  try {
    dropPins([pin]);
    await settle();
    assert.ok(sessionUrls().includes("https://pin.com"), "session.json still has the pin while the backup can't be written");
    assert.equal(backups().length, 0);
    await settle();
    assert.ok(sessionUrls().includes("https://pin.com"), "and still after another save");
  } finally {
    stub.refusedSaves.on = false;
  }
  const later = realNow() + 120_000;
  Date.now = () => later;
  try {
    await settle();
  } finally {
    Date.now = realNow;
  }
  stop();
  assert.deepEqual(backups()[0]?.pins[profileId]?.tabs.map((t) => t.url), ["https://pin.com"], "the backup landed on the retry");
  assert.ok(!sessionUrls().includes("https://pin.com"), "and then the session was written");
});

test("a slow backup write holds the session write until the backup has landed", async () => {
  const { stop, pin, profileId } = onePin();
  stub.heldSaves.on = true;
  try {
    dropPins([pin]);
    await settle();
    assert.ok(sessionUrls().includes("https://pin.com"), "session.json keeps the pin while the backup is landing");
    assert.equal(backups().length, 0);
  } finally {
    stub.heldSaves.on = false;
  }
  for (const land of stub.heldSaves.queue.splice(0)) land();
  await settle();
  stop();
  assert.deepEqual(backups()[0]?.pins[profileId]?.tabs.map((t) => t.url), ["https://pin.com"]);
  assert.ok(!sessionUrls().includes("https://pin.com"));
});

test("quitting while the backup can't be written keeps the old session.json, and doesn't wait", async () => {
  const { stop, pin } = onePin();
  stub.refusedSaves.on = true;
  try {
    dropPins([pin]);
    await settle();
    const started = Date.now();
    flushPersistence({ final: true });
    assert.ok(Date.now() - started < 100, "the final save returns at once");
    assert.ok(sessionUrls().includes("https://pin.com"), "the session on disk keeps the pin");
  } finally {
    stub.refusedSaves.on = false;
    stop();
    resumePersistence();
  }
});

test("saves that drop no pins write the session at once and never touch the backup", () => {
  const { stop, w } = onePin();
  const documents = stub.shellNativeModules.ArdiaDocuments;
  const realSave = documents.saveDocument;
  let backupSaves = 0;
  documents.saveDocument = (name, contents) => {
    if (name === PINS_BACKUP_DOCUMENT) backupSaves++;
    return realSave(name, contents);
  };
  try {
    S().newTab(w, { url: "https://more.com", background: true });
    flushPersistence();
  } finally {
    documents.saveDocument = realSave;
    stop();
  }
  assert.ok(sessionUrls().includes("https://more.com"), "written in the same flush, no wait");
  assert.equal(backupSaves, 0);
});
