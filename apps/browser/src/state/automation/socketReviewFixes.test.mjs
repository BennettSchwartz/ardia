import assert from "node:assert/strict";
import { after, test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
after(() => S().updateSettings({ cliControl: false }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let nextId = 0;
let nextConnection = 1200;
const CONNECTION = 51;

function send(method, params, connection = CONNECTION) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  return async (rounds = 400) => {
    for (let i = 0; i < rounds && !stub.controlSocket.replies.slice(before).some((r) => r.connection === connection && JSON.parse(r.line).id === id); i++) await tick();
    const reply = stub.controlSocket.replies.slice(before).find((r) => r.connection === connection && JSON.parse(r.line).id === id);
    return reply ? JSON.parse(reply.line) : null;
  };
}
const call = async (method, params, connection) => {
  const reply = await send(method, params, connection)();
  assert.ok(reply, `a reply to ${method}`);
  return reply;
};
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
  return { windowId };
}

const eventsFor = (connection, from) => stub.controlSocket.broadcasts.slice(from).filter((b) => b.connections.includes(connection)).map((b) => JSON.parse(b.line)).filter((l) => l.event && !l.decide);

test("settings.set checks the search engine against the settings as they'd end up", async () => {
  await setup();
  const other = (await ok("search.engines")).find((e) => e.id !== DEFAULT_SETTINGS.searchEngine && !e.custom).id;

  await ok("settings.set", { values: { customSearchUrl: "https://find.example/?q=%s", searchEngine: "custom" } });
  assert.deepEqual([S().settings.customSearchUrl, S().settings.searchEngine], ["https://find.example/?q=%s", "custom"], "adding the URL and choosing it at once works");

  assert.equal(await code("settings.set", { values: { customSearchUrl: "", searchEngine: "custom" } }), "bad_request", "no default engine left");
  assert.deepEqual([S().settings.customSearchUrl, S().settings.searchEngine], ["https://find.example/?q=%s", "custom"], "nothing changed");

  await ok("settings.set", { values: { customSearchUrl: "", searchEngine: other } });
  assert.deepEqual([S().settings.customSearchUrl, S().settings.searchEngine], ["", other], "the engine asked for, not the factory default");
});

const urlLeaks = (value, path = "data") => {
  if (typeof value === "string") return /^[a-z][\w+.-]*:\/\/[^\s]*[?#]/i.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => urlLeaks(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => urlLeaks(v, `${path}.${k}`));
  return [];
};

test("every URL in the library events is cut to origin and path for a subscriber without fullUrls", async () => {
  await setup();
  useBrowser.setState({ bookmarksReady: { "": true } });
  const plain = ++nextConnection;
  const star = ++nextConnection;
  const full = ++nextConnection;
  await call("subscribe", { events: ["bookmarks.changed", "history.removed", "download.changed", "profile.changed"] }, plain);
  await call("subscribe", { events: ["*"] }, star);
  await call("subscribe", { events: ["history.removed"], fullUrls: true }, full);
  const from = stub.controlSocket.broadcasts.length;
  S().addBookmark({ profileId: "default", url: "https://mark.example/p?token=1#a", title: "Mark" });
  stub.chromeHistoryEvent({ kind: "deleted", profile: "", all: false, urls: ["https://bank.example/statement?account=42#row", "https://plain.example/"] });
  S().upsertDownload({ id: "dz", url: "https://f.example/a.zip?sig=abc", filename: "a.zip", path: "/tmp/a.zip", state: "downloading", paused: false, received: 1, total: 10, speed: 0, mimeType: "application/zip", profile: "", startTime: 1 });
  await ok("profiles.create", { name: "Leaky?" });
  await wait(20);
  for (const connection of [plain, star]) {
    const events = eventsFor(connection, from).filter((e) => ["bookmarks.changed", "history.removed", "download.changed", "profile.changed"].includes(e.event));
    assert.ok(events.some((e) => e.event === "history.removed"), "history.removed arrived");
    assert.deepEqual(events.flatMap((e) => urlLeaks(e.data, e.event)), [], `connection ${connection} sees no query or fragment`);
  }
  const fullRemoval = eventsFor(full, from).find((e) => e.event === "history.removed");
  assert.deepEqual(fullRemoval.data.urls, ["https://bank.example/statement?account=42#row", "https://plain.example/"], "fullUrls keeps them whole");
  for (const c of [plain, star, full]) stub.emitControlClose(c);
});

test("a huge history removal stays under the event budget, with its full count and a truncated flag", async () => {
  await setup();
  const conn = ++nextConnection;
  await call("subscribe", { events: ["history.removed"], fullUrls: true }, conn);
  const from = stub.controlSocket.broadcasts.length;
  const urls = Array.from({ length: 900 }, (_, i) => `https://long.example/${i}/${"x".repeat(2000)}`);
  stub.chromeHistoryEvent({ kind: "deleted", profile: "", all: false, urls });
  await wait(10);
  const line = stub.controlSocket.broadcasts.slice(from).find((b) => b.connections.includes(conn)).line;
  assert.ok(Buffer.byteLength(line) <= 300 * 1024, `the line is ${Buffer.byteLength(line)} bytes`);
  const event = JSON.parse(line);
  assert.equal(event.data.count, 900);
  assert.equal(event.data.truncated, true);
  assert.ok(event.data.urls.length > 0 && event.data.urls.length < 900);
  stub.emitControlClose(conn);
});

test("history.removed counts each URL as it is escaped on the line, envelope included", async () => {
  await setup();
  const { HISTORY_EVENT_LINE_BYTES } = await import("./libraryEvents.ts");
  const conn = ++nextConnection;
  await call("subscribe", { events: ["history.removed"], fullUrls: true }, conn);
  const from = stub.controlSocket.broadcasts.length;
  const urls = Array.from({ length: 900 }, (_, i) => `https://escape.example/${i}/${"\u0001\"".repeat(150)}`);
  stub.chromeHistoryEvent({ kind: "deleted", profile: "", all: false, urls });
  await wait(10);
  const line = stub.controlSocket.broadcasts.slice(from).find((b) => b.connections.includes(conn)).line;
  assert.ok(Buffer.byteLength(line) + 1 <= HISTORY_EVENT_LINE_BYTES, `the line is ${Buffer.byteLength(line)} bytes`);
  const event = JSON.parse(line);
  assert.equal(event.data.truncated, true);
  assert.ok(event.data.urls.length > 100, `${event.data.urls.length} URLs kept, not a summary`);
  stub.emitControlClose(conn);
});

async function geometrySetup() {
  const { windowId } = await setup();
  stub.windows.geometry.clear();
  if (!stub.windows.open.has(windowId)) stub.windows.open.set(windowId, {});
  const { onWindowEvent } = await import("../../platform/windows.ts");
  const listening = onWindowEvent((e) => e.type === "fullScreen" && S().setWindowFullScreen(e.id, e.on, e.display));
  return { windowId, done: () => listening.remove() };
}

test("full screen: overlapping opposite requests take turns and each answers with the state it reached", async () => {
  const { windowId, done } = await geometrySetup();
  stub.geometryWorld.transitionMs = 30;
  try {
    const enter = send("windows.setFullScreen", { window: windowId, on: true });
    const leave = send("windows.setFullScreen", { window: windowId, on: false });
    const [entered, left] = [await enter(4000), await leave(4000)];
    assert.ok(!entered.error, JSON.stringify(entered.error));
    assert.ok(!left.error, JSON.stringify(left.error));
    assert.deepEqual([entered.result.fullScreen, entered.result.geometry.fullScreen], [true, true]);
    assert.deepEqual([left.result.fullScreen, left.result.geometry.fullScreen], [false, false]);
    assert.equal(!!S().windows[windowId].fullScreen, false);
  } finally {
    stub.geometryWorld.transitionMs = 0;
    done();
  }
});

test("full screen: a transition AppKit hasn't ended answers as a timeout and keeps the window until it ends", async () => {
  const { windowId, done } = await geometrySetup();
  stub.geometryWorld.stalls = true;
  try {
    const stalled = await call("windows.setFullScreen", { window: windowId, on: true });
    assert.equal(stalled.error?.code, "failed", JSON.stringify(stalled));
    assert.match(stalled.error.message, /Timed out/);
    stub.geometryWorld.stalls = false;
    const busy = await call("windows.setFullScreen", { window: windowId, on: false });
    assert.equal(busy.error?.code, "refused", "a later request doesn't start while the earlier transition is still AppKit's");
    stub.finishStalledTransition(windowId);
    await wait(5);
    assert.equal(!!S().windows[windowId].fullScreen, true, "the late end still reached the store");
    const left = await ok("windows.setFullScreen", { window: windowId, on: false });
    assert.equal(left.fullScreen, false);
  } finally {
    stub.geometryWorld.stalls = false;
    done();
  }
});

test("full screen: native success without the store following is a failure, not an ok", async () => {
  const { windowId, done } = await geometrySetup();
  done();
  try {
    const reply = await send("windows.setFullScreen", { window: windowId, on: true })(8000);
    assert.equal(reply?.error?.code, "failed", JSON.stringify(reply));
  } finally {
    stub.windows.geometry.get(windowId).fullScreen = false;
  }
});

test("full screen: a page's own full screen is refused, not reported as done", async () => {
  const { windowId, done } = await geometrySetup();
  try {
    await ok("windows.setFullScreen", { window: windowId, on: true });
    stub.windows.geometry.get(windowId).pageFullScreen = true;
    const reply = await call("windows.setFullScreen", { window: windowId, on: false });
    assert.equal(reply.error?.code, "refused", JSON.stringify(reply));
    stub.windows.geometry.get(windowId).pageFullScreen = false;
    await ok("windows.setFullScreen", { window: windowId, on: false });
  } finally {
    done();
  }
});

test("full screen: turning control off between the native read and the toggle changes nothing", async () => {
  const { windowId, done } = await geometrySetup();
  try {
    const pending = send("windows.setFullScreen", { window: windowId, on: true });
    S().updateSettings({ cliControl: false });
    const reply = await pending();
    assert.equal(reply.error?.code, "failed");
    assert.equal(stub.windows.geometry.get(windowId).fullScreen, false, "the window never toggled");
  } finally {
    S().updateSettings({ cliControl: true });
    done();
  }
});

test("frames: origins far off every display are refused, sizes and coordinates are bounded", async () => {
  const { windowId, done } = await geometrySetup();
  try {
    assert.equal(await code("windows.setFrame", { window: windowId, frame: [1e9, 0, 800, 600] }), "bad_request");
    assert.equal(await code("windows.setFrame", { window: windowId, frame: [0, 0, 800, 1e9] }), "bad_request");
    assert.equal(await code("windows.setFrame", { window: windowId, frame: [50000, 50000, 800, 600] }), "refused", "off every display");
    assert.deepEqual(stub.windows.geometry.get(windowId).frame, [100, 100, 1200, 800], "the window didn't move");
    assert.deepEqual((await ok("windows.setFrame", { window: windowId, frame: [10, 20, 800, 600] })).geometry.frame, [10, 20, 800, 600]);
  } finally {
    done();
  }
});
