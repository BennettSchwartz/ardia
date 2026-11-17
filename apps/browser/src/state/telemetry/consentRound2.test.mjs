import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0);
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const choice = await import("./choice.ts");
const usage = await import("./usage.ts");
const bar = await import("./barLoadFocus.ts");
const diagnostics = await import("./diagnostics.ts");
const profileSwap = await import("./profileSwap.ts");
const defaults = await import("./defaultBrowserCounts.ts");
const passwords = await import("./passwordSaves.ts");
const track = await import("./track.ts");
const stuck = await import("./stuckDrags.ts");
const localReport = await import("./localStoreReport.ts");
const failures = await import("./webNotificationFailures.ts");
const relay = await import("./relay.ts");
const { browserSuggestFetch } = await import("../omnibox/suggestTransport.ts");
const { connectCalendar } = await import("../live/calendar.ts");
const { webviews } = await import("../../platform/webviews.ts");
after(() => client.setSharing(false, "settings"));

const turn = () => new Promise((resolve) => setImmediate(resolve));
const turns = async (n = 6) => {
  for (let i = 0; i < n; i++) await turn();
};
const offAndOn = () => {
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
};

async function queued(event) {
  await client.saveQueueNow();
  const saved = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}');
  return saved.events.filter((e) => e.event === event).map((e) => e.properties);
}

const localRecords = async (event) => {
  const { flushLocal } = await import("./localStore.ts");
  await flushLocal();
  return stub.telemetryLocal.records().filter((r) => r.event === event);
};

test("A3 resetting the anonymous ID while sharing stays on ends the consent period, so earlier work isn't counted", async () => {
  client.loadChoice();
  client.setSharing(true, "onboarding");
  webviews.set("reset-tab", { evaluate: async () => true });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    bar.noteBarLoad("reset-tab");
    client.replaceInstallId();
    mock.timers.tick(2000);
    await turn();
  } finally {
    mock.timers.reset();
  }
  assert.equal(bar.takeBarLoadFocusCounts().bar_loads, 0);
});

test("A3/8 a window that reloads the choice and finds a new consent period, sharing still on, drops tokens from the old one", () => {
  client.setSharing(true, "onboarding");
  const token = client.consentToken();
  stub.docs.set("telemetry.json", JSON.stringify({ ...JSON.parse(stub.docs.get("telemetry.json")), epoch: "another-period", decidedAt: 1 }));
  choice.reloadChoice();
  assert.equal(client.isSharing(), true);
  assert.equal(client.stillValid(token), false);
});

test("4 a profile switch made while sharing was off isn't sent once sharing is on", async () => {
  client.setSharing(false, "settings");
  profileSwap.profileSwitched("w-swap", "same", "same", 2, {});
  client.setSharing(true, "settings");
  await turns();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await turns();
  assert.deepEqual(await queued("profile_switched"), []);
});

test("4 a page process that went away while sharing was off isn't sent once sharing is on", async () => {
  client.setSharing(false, "settings");
  diagnostics.trackPageProcessGone({ reason: "crashed", code: 1 }, true);
  client.setSharing(true, "settings");
  await turns();
  assert.deepEqual(await queued("page_process_gone"), []);
});

test("4 a default-browser check started while sharing was off isn't counted", async () => {
  client.setSharing(false, "settings");
  defaults.takeDefaultBrowserCounts();
  let answer;
  defaults.checkDefaultBrowserAtLaunch(() => new Promise((resolve) => (answer = resolve)));
  client.setSharing(true, "settings");
  answer(true);
  await turns();
  assert.equal(defaults.takeDefaultBrowserCounts().launches_as_default_browser, 0);
});

test("4 a password import begun while sharing was off isn't sent when it finishes after sharing is on", async () => {
  client.setSharing(false, "settings");
  const tally = passwords.passwordImportTally("csv");
  await tally.attempt(Promise.resolve(true));
  client.setSharing(true, "settings");
  tally.done();
  assert.deepEqual(await queued("password_import"), []);
});

test("4 a search suggestion request made while sharing was off isn't counted when its reply comes after", async () => {
  client.setSharing(false, "settings");
  track.takeSearchSuggests();
  let reply;
  globalThis.acTestSuggest = () => new Promise((resolve) => (reply = resolve));
  try {
    const fetched = browserSuggestFetch("")("https://suggest.example/?q=a", { signal: new AbortController().signal });
    await turn();
    client.setSharing(true, "settings");
    reply({ status: 200, body: "[]" });
    await fetched;
  } finally {
    globalThis.acTestSuggest = undefined;
  }
  assert.equal(Object.values(track.takeSearchSuggests()).reduce((a, b) => a + b, 0), 0);
});

test("4 a calendar connection begun while sharing was off isn't sent once sharing is on", async () => {
  client.setSharing(false, "settings");
  const calendar = stub.shellNativeModules.ArdiaCalendar;
  const original = calendar.requestAccess;
  let grant;
  calendar.requestAccess = () => new Promise((resolve) => (grant = resolve));
  try {
    const connected = connectCalendar();
    await turns();
    client.setSharing(true, "settings");
    grant({ granted: false, status: "denied", error: null, responsible: "self", ms: 5 });
    await connected;
  } finally {
    calendar.requestAccess = original;
  }
  assert.deepEqual(await queued("calendar_connect"), []);
});

test("4 a custom filter list added while sharing was off isn't counted when the download finishes after", async () => {
  client.setSharing(false, "settings");
  const token = client.consentToken();
  client.setSharing(true, "settings");
  usage.noteCustomFilterList("added", token);
  usage.sessionEnding();
  assert.ok((await queued("usage_counts")).every((p) => !p.content_blocker_custom_lists_added));
});

test("7 a CLI status read started before sharing went off and on again doesn't refill drag and windowless-page counts", async () => {
  client.setSharing(true, "onboarding");
  stuck.takeStuckDragCounts();
  let status;
  globalThis.acTestCliControl = () => new Promise((resolve) => (status = resolve));
  try {
    const context = diagnostics.recordContext();
    offAndOn();
    status({ on: true, installed: true, dragsEnded: { ownerGone: 3, debuggerUnowned: 0, nativeRefused: 0 }, windowlessPages: { given: 0, missed: 0 } });
    await context;
    await turns();
  } finally {
    globalThis.acTestCliControl = undefined;
  }
  assert.equal(Object.values(stuck.takeStuckDragCounts()).reduce((a, b) => a + b, 0), 0);
});

test("7/10 a memory sample and settings snapshot started before sharing went off and on again leave no trace, and the settings day isn't used up", async () => {
  client.setSharing(true, "onboarding");
  globalThis.acTestTasks = () => [{ type: "browser", memory: 300 * 1_048_576 }];
  try {
    const hour = usage.devHourly();
    offAndOn();
    await hour;
  } finally {
    globalThis.acTestTasks = undefined;
  }
  const context = await diagnostics.recordContext();
  assert.equal(context?.app_memory_mb ?? null, null);
  assert.equal(client.settingsSnapshotDay(), null);
});

test("7 local-store meters from while sharing was off aren't reported once sharing is on", async () => {
  client.setSharing(false, "settings");
  for (let i = 0; i < 40; i++) client.capture("off_period_line", {}, client.consentNow());
  client.setSharing(true, "settings");
  const props = await localReport.reportLocalStore();
  assert.ok((props?.lines_recorded ?? 0) < 40, `lines_recorded ${props?.lines_recorded}`);
});

test("8 a relaying window forwards work with the consent token taken when it began, not the one current when it's forwarded", () => {
  client.setSharing(true, "onboarding");
  const token = client.consentToken();
  offAndOn();
  const forwarded = [];
  relay.setTelemetryRelay({ capture: (event, _props, consent) => forwarded.push([event, consent]), log: () => {}, resetId: async () => "", change: () => {}, installId: () => null });
  try {
    client.capture("relayed_old_work", {}, token);
  } finally {
    relay.setTelemetryRelay(null);
  }
  assert.deepEqual(forwarded, [["relayed_old_work", token]]);
});

test("9 turning sharing off resolves only once the choice is on disk", async () => {
  client.setSharing(true, "onboarding");
  const result = client.setSharing(false, "settings");
  assert.equal(typeof result?.then, "function");
  assert.equal(await result, true);
});

test("D a notification failure from before sharing was turned on is still in the local copy, marked not sent", async () => {
  client.setSharing(false, "settings");
  const token = client.consentToken();
  client.setSharing(true, "settings");
  await failures.recordWebNotificationPost(Promise.resolve({ icon: "none", errorCode: 1 }), { titleLength: 1, bodyLength: 1, iconRequested: false, iconSent: false }, token);
  const local = await localRecords("web_notification_failed");
  assert.equal(local.length >= 1, true);
  assert.equal(local.at(-1).sent, false);
  assert.deepEqual(await queued("web_notification_failed"), []);
});

test("4 app_launched for a launch while sharing was off isn't sent when sharing is turned on during the hardware read", async () => {
  client.setSharing(false, "settings");
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  try {
    usage.startUsage(false);
    client.setSharing(true, "settings");
    await turns(10);
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(await queued("app_launched"), []);
});

test("D a bar load whose focus check finishes after sharing went off and on again is in the local copy, marked not sent", async () => {
  client.setSharing(true, "onboarding");
  webviews.set("local-bar-tab", { evaluate: async () => true });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    bar.noteBarLoad("local-bar-tab");
    offAndOn();
    mock.timers.tick(2000);
    await turn();
  } finally {
    mock.timers.reset();
  }
  const local = (await localRecords("usage_counts")).filter((r) => r.properties?.bar_loads === 1);
  assert.equal(local.length, 1);
  assert.equal(local[0].sent, false);
  assert.equal(bar.takeBarLoadFocusCounts().bar_loads, 0);
});

test("D a window focused while sharing is off is still checked into the local copy, marked not sent", async () => {
  client.setSharing(false, "settings");
  stub.chromeWindowList.splice(0, stub.chromeWindowList.length, { id: "w-local", key: true, visible: true, chromeOccluded: true, occlusionVisible: true });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    stub.windows.emit({ type: "focus", windowId: "w-local" });
    mock.timers.tick(1500);
    await turns();
  } finally {
    mock.timers.reset();
    stub.chromeWindowList.splice(0);
  }
  const local = (await localRecords("usage_counts")).filter((r) => r.properties?.focused_window_checks === 1);
  assert.equal(local.length, 1);
  assert.equal(local[0].sent, false);
});

const transport = await import("./transport.ts");
const identity = await import("./identity.ts");
const localStore = await import("./localStore.ts");

test("PRRT_kwDOS_pvMc64oe4k an anonymous ID reset begun while sharing was off isn't sent when sharing is turned on during it", async () => {
  client.setSharing(false, "settings");
  const local = stub.shellNativeModules.ArdiaTelemetryLocal;
  const clear = local.clear;
  let cleared;
  local.clear = () => new Promise((resolve) => (cleared = resolve));
  try {
    const reset = identity.resetAnonymousId();
    await turn();
    client.setSharing(true, "settings");
    cleared();
    await reset;
  } finally {
    local.clear = clear;
  }
  assert.deepEqual(await queued("anonymous_id_reset"), []);
});

test("PRRT_kwDOS_pvMc64oe4k an anonymous ID reset made while sharing stays on is still sent", async () => {
  client.setSharing(true, "onboarding");
  await identity.resetAnonymousId();
  assert.equal((await queued("anonymous_id_reset")).length, 1);
});

test("PRRT_kwDOS_pvMc64oe4G an upload that finishes after sharing went off and on again doesn't count in the new period's post stats", async () => {
  client.setSharing(true, "onboarding");
  transport.takePostStats();
  const host = transport.telemetryHost();
  let reply;
  transport.setTelemetryHost({ ...host, send: () => new Promise((resolve) => (reply = resolve)) });
  try {
    const sent = transport.post("events", "{}", 1);
    offAndOn();
    reply(200);
    await sent;
  } finally {
    transport.setTelemetryHost(host);
  }
  assert.deepEqual(transport.takePostStats(), { bytes: 0, failed: 0, requests: 0 });
});

test("PRRT_kwDOS_pvMc64oe4G uploads from an earlier consent period aren't reported in the next one", async () => {
  client.setSharing(true, "onboarding");
  transport.takePostStats();
  const host = transport.telemetryHost();
  transport.setTelemetryHost({ ...host, send: async () => 200 });
  try {
    await transport.post("events", "{}", 1);
  } finally {
    transport.setTelemetryHost(host);
  }
  offAndOn();
  assert.deepEqual(transport.takePostStats(), { bytes: 0, failed: 0, requests: 0 });
});

test("PRRT_kwDOS_pvMc64oe4_ a local-store report begun while sharing was off doesn't consume the meters of the period after it", async () => {
  client.setSharing(false, "settings");
  const local = stub.shellNativeModules.ArdiaTelemetryLocal;
  const prune = local.prune;
  const held = [];
  local.prune = (now) => new Promise((resolve) => held.push(() => resolve(prune(now))));
  const release = () => held.splice(0).forEach((go) => go());
  let stale;
  try {
    stale = localReport.reportLocalStore();
    await turn();
    client.setSharing(true, "settings");
    for (let i = 0; i < 5; i++) client.capture("new_period_line", {}, client.consentNow());
    release();
    await stale;
  } finally {
    local.prune = prune;
  }
  const fresh = await localReport.reportLocalStore();
  assert.ok((fresh?.lines_recorded ?? 0) >= 5, `lines_recorded ${fresh?.lines_recorded}`);
  assert.deepEqual(await queued(localReport.LOCAL_STORE_EVENT).then((all) => all.filter((p) => p.lines_recorded >= 5).length), 1);
});

const extensionInstalls = await import("./extensionInstalls.ts");

test("5 an extension install confirmed while sharing was off isn't sent when it finishes after sharing is on, and one confirmed while on is", async (t) => {
  extensionInstalls.watchExtensionInstalls(Date.now());
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
  t.after(() => mock.timers.reset());
  const prompt = (id) => ({ requestId: `r-${id}`, profile: "", id, name: "x", version: "1", type: "install", icon: "", permissions: [], tabId: null });
  client.setSharing(false, "settings");
  stub.emitEvent("extensions.installPrompt", prompt("off-ext"));
  client.setSharing(true, "settings");
  stub.emitEvent("extensions.changed", { profile: "", id: "off-ext", event: "installed" });
  assert.deepEqual(await queued("extension_installed"), []);
  stub.emitEvent("extensions.installPrompt", prompt("on-ext"));
  stub.emitEvent("extensions.changed", { profile: "", id: "on-ext", event: "installed" });
  assert.equal((await queued("extension_installed")).length, 1);
});
