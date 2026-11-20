import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0);
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const track = await import("./track.ts");
after(() => client.setSharing(false, "settings"));

const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
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
