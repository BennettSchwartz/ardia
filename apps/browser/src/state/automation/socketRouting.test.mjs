import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { SOURCES } = await import("../live/sources.ts");
const { live, setAccount } = await import("../live/store.ts");
const { resetAirTrafficForTests } = await import("../airTraffic/store.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 19, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 100 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 19); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 19);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}

const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const code = async (method, params) => (await call(method, params)).error?.code;

async function setup() {
  S().hydrate({});
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  return { windowId, profile: S().windows[windowId].profileId };
}

const pr = (id, number) => ({ id, source: "github", url: `https://github.com/o/r/pull/${number}`, title: `PR ${number}`, subtitle: "", icon: null, updatedAt: number, section: "authored", pr: { number, repo: "o/r", headRef: `b${number}`, baseRef: "main" } });

test("live folders: make one, fetch, hide and show items, mark read, open one, rename, delete", async () => {
  const { windowId, profile } = await setup();
  const { fetch } = SOURCES.github;
  SOURCES.github.fetch = async () => [pr("one", 1), pr("two", 2)];
  setAccount("github", { login: "me", name: null, avatar: null, connectedAt: 1 });
  try {
    assert.equal(await code("live.create", { kind: "pullRequests", sources: ["notion"] }), "bad_request");
    assert.equal(await code("live.create", { kind: "pullRequests", sources: ["bitbucket"] }), "refused");
    const made = await ok("live.create", { kind: "pullRequests", name: "Mine" });
    assert.equal(made.profile, profile);
    assert.deepEqual(made.sources, ["github"]);
    const fetched = await ok("live.refresh", { folder: made.id });
    assert.equal(fetched.items, 2);
    const listed = await ok("live.list");
    assert.equal(listed.folders.find((f) => f.id === made.id)?.name, "Mine");
    assert.equal(listed.accounts.github.login, "me");
    assert.deepEqual((await ok("live.items", { folder: made.id })).items.map((it) => it.id).sort(), ["one", "two"]);
    const hidden = await ok("live.hide", { folder: made.id, items: ["two"] });
    assert.equal(hidden.items, 1);
    assert.equal(hidden.hidden, 1);
    assert.equal(await code("live.hide", { folder: made.id, items: ["nope"] }), "no_window");
    assert.equal((await ok("live.unhide", { folder: made.id })).items, 2);
    await ok("live.markRead", { folder: made.id });
    assert.deepEqual(live().unread[made.id] ?? [], []);
    const updated = await ok("live.update", { folder: made.id, name: "Reviews", collapsed: true, color: "blue", filters: { authored: false } });
    assert.deepEqual([updated.name, updated.collapsed, updated.color, updated.filters.authored, updated.filters.reviewRequests], ["Reviews", true, "blue", false, true]);
    assert.equal(await code("live.update", { folder: made.id }), "bad_request");
    assert.equal(await code("live.update", { folder: made.id, color: "mauve" }), "bad_request");
    const opened = await ok("live.open", { folder: made.id, item: "one", window: windowId });
    assert.equal(S().tabs[opened.tab].liveItem?.itemId, "one");
    await ok("live.remove", { folder: made.id });
    assert.equal(live().folders[made.id], undefined);
    assert.equal(S().tabs[opened.tab], undefined, "its tab closes with it");
    assert.equal(await code("live.items", { folder: made.id }), "no_window");
  } finally {
    SOURCES.github.fetch = fetch;
    setAccount("github", null);
  }
});

test("air traffic: add, change, order and remove rules, set Everything Else, test a link", async () => {
  await setup();
  resetAirTrafficForTests();
  const work = S().createProfile({ name: "Work" });
  const slack = { name: "Slack", bundleId: "com.tinyspeck.slackmacgap" };
  const first = await ok("airTraffic.addRule", { from: slack, when: { kind: "site", host: "https://GitHub.com/x" }, profile: work });
  assert.deepEqual([first.from, first.when, first.profileId, first.open, first.enabled], [slack, { kind: "site", host: "github.com" }, work, "tab", true]);
  const second = await ok("airTraffic.addRule", { when: { kind: "contains", text: "figma" }, open: "littleArdia" });
  assert.equal(second.profileId, null);
  assert.deepEqual((await ok("airTraffic.rules")).rules.map((r) => r.id), [first.id, second.id]);
  assert.ok((await ok("airTraffic.rules")).profiles.some((p) => p.id === work));
  const routed = await ok("airTraffic.test", { url: "https://github.com/ardia", from: slack });
  assert.equal(routed.profileName, "Work");
  assert.equal(routed.open, "tab");
  const off = await ok("airTraffic.updateRule", { id: first.id, enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.when.host, "github.com", "what wasn't given stays");
  assert.deepEqual(await ok("airTraffic.moveRule", { id: second.id, index: 0 }), [second.id, first.id]);
  assert.deepEqual((await ok("airTraffic.setFallback", { open: "window", profile: work })).fallback, { profileId: work, open: "window" });
  assert.deepEqual((await ok("airTraffic.setFallback", { open: null })).fallback, null);
  assert.equal(await code("airTraffic.addRule", { when: { kind: "site", pattern: "*x*" } }), "bad_request");
  assert.equal(await code("airTraffic.addRule", { when: { kind: "pattern", pattern: "has space" } }), "bad_request");
  assert.equal(await code("airTraffic.addRule", { when: { kind: "any" }, open: "window", group: "g1" }), "bad_request");
  assert.equal(await code("airTraffic.addRule", { when: { kind: "any" }, profile: "nope" }), "no_window");
  assert.equal(await code("airTraffic.addRule", { when: { kind: "any" }, profile: work, group: "nope" }), "no_window");
  assert.equal(await code("airTraffic.updateRule", { id: "nope", enabled: true }), "no_window");
  await ok("airTraffic.removeRule", { id: first.id });
  assert.deepEqual((await ok("airTraffic.rules")).rules.map((r) => r.id), [second.id]);
  assert.ok(stub.docs.get("air-traffic.json")?.includes(second.id), "the rules are saved");
});

test("air traffic rules route into a group, and a profile change drops the group", async () => {
  const { windowId, profile } = await setup();
  resetAirTrafficForTests();
  const tab = S().newTab(windowId, { url: "https://g.example/", background: true });
  S().groupTabs([tab], { pinned: true, name: "Docs" });
  const { groups } = (await ok("airTraffic.rules")).profiles.find((p) => p.id === profile);
  const docs = groups.find((g) => g.name === "Docs");
  assert.ok(docs, "the group is offered");
  const rule = await ok("airTraffic.addRule", { when: { kind: "any" }, profile, group: docs.key });
  assert.equal(rule.groupKey, docs.key);
  const other = S().createProfile({ name: "Other" });
  assert.equal((await ok("airTraffic.updateRule", { id: rule.id, profile: other })).groupKey, undefined);
});

test("air traffic: a move is one write, so a save failing after it can't leave a half-moved order", async () => {
  await setup();
  resetAirTrafficForTests();
  const ids = [];
  for (const text of ["one", "two", "three", "four"]) ids.push((await ok("airTraffic.addRule", { when: { kind: "contains", text } })).id);
  const moved = [ids[3], ids[0], ids[1], ids[2]];
  let writes = 0;
  Object.defineProperty(stub.refusedWrites, "on", { get: () => ++writes > 1, configurable: true });
  try {
    assert.deepEqual(await ok("airTraffic.moveRule", { id: ids[3], index: 0 }), moved);
  } finally {
    Object.defineProperty(stub.refusedWrites, "on", { value: false, writable: true, configurable: true });
  }
  assert.equal(writes, 1, "one write");
  assert.deepEqual(JSON.parse(stub.docs.get("air-traffic.json")).rules.map((r) => r.id), moved);
  stub.refusedWrites.on = true;
  try {
    assert.equal(await code("airTraffic.moveRule", { id: ids[3], index: 3 }), "failed");
  } finally {
    stub.refusedWrites.on = false;
  }
  assert.deepEqual((await ok("airTraffic.rules")).rules.map((r) => r.id), moved, "a failed move changes nothing");
  assert.deepEqual(JSON.parse(stub.docs.get("air-traffic.json")).rules.map((r) => r.id), moved);
});

test("air traffic: an inherited name isn't a profile", async () => {
  await setup();
  resetAirTrafficForTests();
  for (const profile of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(await code("airTraffic.addRule", { when: { kind: "any" }, profile }), "no_window", profile);
    assert.equal(await code("airTraffic.setFallback", { open: "tab", profile }), "no_window", profile);
  }
  assert.deepEqual((await ok("airTraffic.rules")).rules, []);
});

