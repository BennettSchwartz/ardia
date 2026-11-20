import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0);
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const track = await import("./track.ts");
const { useMedia } = await import("../media/media.ts");
const screenShare = await import("../media/screenShare.ts");
const { webviews } = await import("../../platform/webviews.ts");
after(() => client.setSharing(false, "settings"));

const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};
const queuedUsage = async () => {
  usage.emitWindowUsage(client.consentNow());
  await client.saveQueueNow();
  return JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === "usage_counts");
};

test("a keystroke made while sharing was off is never sampled, even when another omnibox's keystroke comes after opt-in", () => {
  sharing(false);
  const commandBar = track.newOmniboxKey();
  track.omniboxKeyHeard(commandBar);
  sharing(true);
  track.takeOmniboxLatency();
  const toolbarField = track.newOmniboxKey();
  for (let i = 0; i < 4; i++) {
    track.omniboxKeyHeard(toolbarField);
    track.sampleOmniboxLatency(toolbarField);
  }
  track.omniboxKeyHeard(toolbarField);
  track.sampleOmniboxLatency(commandBar);
  assert.deepEqual(track.takeOmniboxLatency(), []);
  track.sampleOmniboxLatency(toolbarField);
  assert.equal(track.takeOmniboxLatency().length, 1, "the bar that was keyed after opt-in still samples");
});

test("a tab picked to share while sharing was off isn't counted when its source arrives after a consent change", async () => {
  sharing(true);
  await queuedUsage();
  sharing(false);
  let resolveSource = () => {};
  useMedia.setState({ displayRequests: { asker: { id: "r1", origin: "https://meet.test", controller: false, pageUrl: "https://meet.test/" } } });
  webviews.set("shared", { mediaCaptureSourceId: () => new Promise((resolve) => (resolveSource = resolve)), resolveDisplayMedia: async () => {} });
  webviews.set("asker", { resolveDisplayMedia: async () => {} });
  const picking = screenShare.shareTab("asker", "shared", false);
  sharing(true);
  resolveSource("tab:42");
  await picking;
  const picked = (await queuedUsage()).filter((e) => (e.properties.shares_picked_tab ?? 0) > 0);
  assert.deepEqual(picked, []);
  webviews.delete("shared");
  webviews.delete("asker");
});
