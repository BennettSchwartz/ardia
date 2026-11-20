import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));
const { noteLittleArdiaLinkKeptBehind, takeLittleArdiaEscapeCloses } = await import("./littleArdiaEscapes.ts");

test("a link from another app counts when Ardia kept its other windows behind that app, by the moment it did", () => {
  takeLittleArdiaEscapeCloses();
  noteLittleArdiaLinkKeptBehind("activation");
  noteLittleArdiaLinkKeptBehind("activation");
  noteLittleArdiaLinkKeptBehind("arrival");
  noteLittleArdiaLinkKeptBehind("open");
  noteLittleArdiaLinkKeptBehind("released");
  noteLittleArdiaLinkKeptBehind("stageManager");
  const taken = takeLittleArdiaEscapeCloses();
  assert.equal(taken.little_ardia_link_windows_kept_at_activation, 2);
  assert.equal(taken.little_ardia_link_windows_kept_on_arrival, 1);
  assert.equal(taken.little_ardia_link_windows_kept_on_open, 1);
  assert.equal(taken.little_ardia_link_holds_without_link, 1);
  assert.equal(taken.little_ardia_link_holds_left_to_stage_manager, 1);
  assert.equal(takeLittleArdiaEscapeCloses().little_ardia_link_windows_kept_at_activation, 0, "taking the counts starts the next hour at zero");
});
