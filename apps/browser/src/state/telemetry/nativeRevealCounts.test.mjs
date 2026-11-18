import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
const { NativeModules } = await import("react-native");
Object.assign(stub.appInfo, { appVersion: "0.3.0", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false, processStart: Date.now() - 1500 });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, installId: "install", decidedAt: 1, askDoneAt: 1, crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false }));
let marks = [];
NativeModules.ACFieldTiming.drain = () => {
  const out = marks;
  marks = [];
  return out;
};
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const journeys = await import("./journeys.ts");
after(() => client.setSharing(false, "settings"));

test("pages shown natively before JS switched, and the ones taken back, are counted even when no switch followed", async () => {
  client.loadChoice();
  journeys.startJourneys(null);
  const at = Date.now();
  marks = [["tab-b", "nativeReveal", at], ["tab-b", "view", at], ["tab-c", "nativeReveal", at + 5], ["tab-c", "nativeRevealDropped", at + 9], ["tab-c", "nativeRevealFocus", at + 6]];
  journeys.emitJourneys();
  await client.saveQueueNow();
  const sent = JSON.parse(stub.docs.get("telemetry-queue.json")).events.filter((e) => e.event === "perf_journeys");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].properties.j3_native, 2);
  assert.equal(sent[0].properties.j3_native_dropped, 1);
  assert.equal(sent[0].properties.j3_native_focus, 1);
  assert.equal(JSON.stringify(sent[0]).includes("tab-b"), false, "no tab ids go out");
});

test("a switch native code showed first is timed from its press, however long JS took to hear of it", async () => {
  const { useBrowser } = await import("../browser/store.ts");
  const S = () => useBrowser.getState();
  const tab = (id) => ({
    id, windowId: "w1", profileId: "default", url: `https://${id}.com/`, title: "", favicon: null, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null,
    pinnedUrl: null, page: { kind: "loaded", nav: { url: `https://${id}.com/`, seq: 1 } }, openerId: null, createdAt: 0, lastActiveAt: 0,
  });
  S().hydrate({
    profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } },
    windows: { w1: { id: "w1", profileId: "default", kind: "main", tabIds: ["a", "b"], activeTabIds: { default: "a" }, sidebarOpen: true, frame: null, createdAt: 0 } },
    tabs: { a: tab("a"), b: tab("b") },
    focusedWindowId: "w1",
  });
  journeys.emitJourneys();
  const pressed = Date.now() - 2600;
  NativeModules.ACFieldTiming.lastInput = () => [pressed + 40, 2];
  marks = [["b", "nativePress", pressed], ["b", "nativeReveal", pressed + 1], ["b", "view", pressed + 4]];
  S().activate("b");
  const pending = journeys.devJourneys().pending;
  assert.equal(pending.length, 1, "the release is 2.6 s old by now, yet the journey starts");
  assert.equal(pending[0].t0, pressed, "from the press, not the release");
  journeys.emitJourneys(true);
  await client.saveQueueNow();
  const sent = JSON.parse(stub.docs.get("telemetry-queue.json")).events.filter((e) => e.event === "perf_journeys").at(-1);
  assert.equal(sent.properties.j3_view_p50, 4);
  assert.ok(sent.properties.j3_js_p50 >= 2600);
  assert.equal(sent.properties.j3_warm, 1);
});
