import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install-1", crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false }));
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const local = await import("./localStore.ts");
const { recordLog } = await import("./logs.ts");
client.loadChoice();
after(() => client.setSharing(false, "settings"));

test("two different lines that fit the same template are both kept in the local copy with their own text, as before templates", async () => {
  recordLog("warn", ["[airTraffic] couldn't save firstrules"], client.consentToken());
  recordLog("warn", ["[airTraffic] couldn't save secondrules"], client.consentToken());
  await local.flushLocal();
  const texts = stub.telemetryLocal.records().filter((r) => r.kind === "log" && r.message === "[airTraffic] couldn't save {}").map((r) => r.text);
  assert.deepEqual(texts.slice(-2), ["[airTraffic] couldn't save firstrules", "[airTraffic] couldn't save secondrules"]);
});

test("a window that relays its logs forwards the original line for the leader's local copy alongside the template", async () => {
  const { setTelemetryRelay } = await import("./relay.ts");
  const forwarded = [];
  setTelemetryRelay({ capture: () => {}, log: (_level, message, _attributes, _consent, text) => forwarded.push([message, text]), resetId: async () => "", change: async () => true, installId: () => null });
  try {
    recordLog("warn", ["[airTraffic] couldn't save relayedrules"], client.consentToken());
  } finally {
    setTelemetryRelay(null);
  }
  assert.deepEqual(forwarded, [["[airTraffic] couldn't save {}", "[airTraffic] couldn't save relayedrules"]]);
});
