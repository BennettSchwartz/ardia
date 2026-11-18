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
