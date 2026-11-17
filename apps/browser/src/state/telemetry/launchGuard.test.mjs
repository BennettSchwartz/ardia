import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { launchGuardProperties, waitedForPreviousBucket, LAUNCH_GUARD_DOC } = await import("./diagnostics.ts");

const reading = (contents) => (name) => (name === LAUNCH_GUARD_DOC ? contents : null);

test("the Windows engine's launch guard facts become app_launched properties", () => {
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":2875,"unfinishedStartsBefore":0,"restoreStateSetAside":false}')), {
    launch_waited_for_previous: "<3s",
    launch_unfinished_starts_before: 0,
    launch_restore_state_set_aside: false,
  });
});

test("a recovered stuck profile is reported with its unfinished starts", () => {
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":0,"unfinishedStartsBefore":2,"restoreStateSetAside":true}')), {
    launch_waited_for_previous: "0",
    launch_unfinished_starts_before: 2,
    launch_restore_state_set_aside: true,
  });
});

test("a start another Ardia still held the profile for is reported", () => {
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":45012,"unfinishedStartsBefore":0,"restoreStateSetAside":false,"profileHeldByAnother":true}')), {
    launch_waited_for_previous: "45s+",
    launch_unfinished_starts_before: 0,
    launch_restore_state_set_aside: false,
    launch_profile_held_by_another: true,
  });
});

test("the wait for a previous Ardia is sent as a bucket, never in milliseconds", () => {
  assert.deepEqual(
    [0, 1, 999, 1000, 2999, 3000, 9999, 10_000, 29_999, 30_000, 44_999, 45_000, 120_000].map(waitedForPreviousBucket),
    ["0", "<1s", "<1s", "<3s", "<3s", "<10s", "<10s", "<30s", "<30s", "<45s", "<45s", "45s+", "45s+"],
  );
  const properties = launchGuardProperties(reading('{"waitedForPreviousMs":4321,"unfinishedStartsBefore":0,"restoreStateSetAside":false}'));
  assert.equal(properties.launch_waited_for_previous, "<10s");
  assert.ok(!Object.values(properties).includes(4321), "the raw wait is not sent");
});

test("a launch replayed after a quitting Ardia ended is reported with how many launches it carried", () => {
  assert.deepEqual(
    launchGuardProperties(
      reading('{"waitedForPreviousMs":3800,"unfinishedStartsBefore":0,"restoreStateSetAside":false,"profileHeldByAnother":false,"refusedStartsBefore":0,"replayedFrom":"quitting","replayedLaunches":2}'),
    ),
    {
      launch_waited_for_previous: "<10s",
      launch_unfinished_starts_before: 0,
      launch_restore_state_set_aside: false,
      launch_profile_held_by_another: false,
      launch_refused_starts_before: 0,
      launch_replayed_from: "quitting",
      launch_replayed_launches: 2,
    },
  );
});

test("a launch started again after Chromium refused it, and earlier refused starts, are reported", () => {
  assert.deepEqual(
    launchGuardProperties(
      reading('{"waitedForPreviousMs":0,"unfinishedStartsBefore":0,"restoreStateSetAside":false,"profileHeldByAnother":false,"refusedStartsBefore":3,"replayedFrom":"refused","replayedLaunches":1}'),
    ),
    {
      launch_waited_for_previous: "0",
      launch_unfinished_starts_before: 0,
      launch_restore_state_set_aside: false,
      launch_profile_held_by_another: false,
      launch_refused_starts_before: 3,
      launch_replayed_from: "refused",
      launch_replayed_launches: 1,
    },
  );
});

test("an unknown replay source or a replay without launches adds no replay properties", () => {
  const base = '"waitedForPreviousMs":0,"unfinishedStartsBefore":0,"restoreStateSetAside":false';
  for (const replay of ['"replayedFrom":"somewhere","replayedLaunches":1', '"replayedFrom":"quitting","replayedLaunches":0', '"replayedFrom":"quitting"', '"replayedLaunches":2']) {
    const properties = launchGuardProperties(reading(`{${base},${replay}}`));
    assert.equal(properties.launch_replayed_from, undefined, replay);
    assert.equal(properties.launch_replayed_launches, undefined, replay);
  }
});

test("no file, a broken file or odd values add nothing", () => {
  assert.deepEqual(launchGuardProperties(reading(null)), {});
  assert.deepEqual(launchGuardProperties(reading("{not json")), {});
  assert.deepEqual(launchGuardProperties(reading("[]")), {});
  assert.deepEqual(launchGuardProperties(reading('{"waitedForPreviousMs":-4,"unfinishedStartsBefore":"2","restoreStateSetAside":"yes","profileHeldByAnother":1,"refusedStartsBefore":-1,"replayedFrom":7}')), {});
  assert.deepEqual(launchGuardProperties(() => { throw new Error("no documents"); }), {});
});
