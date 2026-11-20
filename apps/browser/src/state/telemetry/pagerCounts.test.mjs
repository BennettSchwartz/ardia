import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { noteProfileDotReorder, notePagerSettle, takePagerCounts } = await import("./pagerCounts.ts");

test("pager settles are counted, those that kept the profile apart, switcher reorders too, and taking them starts over", () => {
  notePagerSettle(true);
  notePagerSettle(false);
  notePagerSettle(false);
  noteProfileDotReorder();
  assert.deepEqual(takePagerCounts(), { profile_pager_settles: 3, profile_pager_settles_without_switch: 2, profile_dot_reorders: 1 });
  assert.deepEqual(takePagerCounts(), { profile_pager_settles: 0, profile_pager_settles_without_switch: 0, profile_dot_reorders: 0 });
});
