import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
Object.assign(stub.appInfo, { appVersion: "0.3.0", appBuild: "300", osVersion: "27.0.1", arch: "arm64", isolatedInstance: false });
stub.docs.set("telemetry.json", JSON.stringify({ version: 1, sharing: true, decidedAt: 1, askDoneAt: 1, installId: "install-1", crashCursor: 0, lastVersion: "0.3.0", sessionOpen: false }));
globalThis.fetch = async () => ({ status: 200 });

const client = await import("./client.ts");
const local = await import("./localStore.ts");
const { recordLog } = await import("./logs.ts");
const { LOG_TEMPLATES } = await import("./logTemplates.ts");
client.startClient();
after(() => {
  client.setSharing(false, "settings");
  local.flushLocal();
});

const queued = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[],"logs":[]}');
const attributesOf = (log) => Object.fromEntries(log.attributes.map((a) => [a.key, a.value.stringValue]));

test("an Error after the label queues its type and code, and its message only when it is one of Ardia's own", () => {
  const error = Object.assign(new Error("release of tab 1234567 failed for https://example.com/a at /Users/me/host.ts"), { code: "ERR_ENGINE" });
  recordLog("error", ["[ardia host] release failed", error]);
  client.saveQueueNow();
  const log = queued().logs.at(-1);
  const attributes = attributesOf(log);
  assert.equal(attributes.error_type, "Error");
  assert.ok(!("error_message" in attributes));
  assert.equal(attributes.error_code, "ERR_ENGINE");
  assert.doesNotMatch(JSON.stringify(log), /example\.com|1234567|\/Users\/me|release of tab/);
  local.flushLocal();
  const record = stub.telemetryLocal.records().findLast((r) => r.kind === "log");
  assert.equal(record.message, "[ardia host] release failed");
  assert.ok(!("error_message" in record.attributes));
  assert.equal(record.attributes.error_code, "ERR_ENGINE");
});

test("an Error with no message or no usable code adds only what it has", () => {
  recordLog("error", ["[ardia host]", Object.assign(new TypeError(""), { code: "not a code!" })]);
  client.saveQueueNow();
  const attributes = attributesOf(queued().logs.at(-1));
  assert.equal(attributes.error_type, "TypeError");
  assert.ok(!("error_message" in attributes));
  assert.ok(!("error_code" in attributes));
});

test("a log line with no Error keeps error_type none and gets no message or code", () => {
  recordLog("warn", ["a plain warning", { code: "X" }, "detail"]);
  client.saveQueueNow();
  const attributes = attributesOf(queued().logs.at(-1));
  assert.equal(attributes.error_type, "none");
  assert.ok(!("error_message" in attributes));
  assert.ok(!("error_code" in attributes));
});

test("one label with two different reasons is queued twice, the same reason only once", () => {
  const before = queued().logs.length;
  recordLog("error", ["[ardia host] release failed", new Error("Window close cancelled")]);
  recordLog("error", ["[ardia host] release failed", new Error("Window close cancelled")]);
  client.saveQueueNow();
  assert.equal(queued().logs.length, before + 1);
  recordLog("error", ["[ardia host] release failed", new Error("Window close is no longer current")]);
  client.saveQueueNow();
  const logs = queued().logs;
  assert.equal(logs.length, before + 2);
  assert.equal(attributesOf(logs.at(-2)).error_message, "Window close cancelled");
  assert.equal(attributesOf(logs.at(-1)).error_message, "Window close is no longer current");
});

const sentFor = (label, error) => {
  const before = queued().logs.length;
  recordLog("error", [label, error]);
  client.saveQueueNow();
  const logs = queued().logs;
  assert.equal(logs.length, before + 1);
  assert.equal(logs.at(-1).body.stringValue, label);
  return attributesOf(logs.at(-1));
};

for (const [name, label, message] of [
  ["a token in the message", "[sync] cycle failed", "Authorization failed for Bearer qwertySecretToken"],
  ["an extension's own error", "[favicons] lookup failed", "Extension 'abc' threw: something"],
  ["a page's error text", "[bookmarks] export failed", "Uncaught TypeError: foo is not a function at https://site.example/app.js:1:2"],
  ["a file path", "[launch] deferred work failed", "Could not open /Users/someone/secret.txt"],
]) {
  test(`an error message that isn't one of Ardia's own is left out: ${name}`, () => {
    const attributes = sentFor(label, new Error(message));
    assert.equal(attributes.error_type, "Error");
    assert.ok(!("error_message" in attributes), JSON.stringify(attributes));
  });
}

test("an error code Ardia doesn't define is left out", () => {
  const attributes = sentFor("[extensions] list failed", Object.assign(new Error("x"), { code: "SOME_RANDOM_CODE" }));
  assert.ok(!("error_code" in attributes), JSON.stringify(attributes));
});

test("the native call template and Ardia's own message and code are sent", async () => {
  const { ArdiaError } = await import("@ardia/core");
  const native = sentFor("[ardia host] tab listener failed", Object.assign(new Error("Calling the 'closeWindow' function has failed"), { code: "ERR_ENGINE" }));
  assert.equal(native.error_message, "Calling the 'closeWindow' function has failed");
  assert.equal(native.error_code, "ERR_ENGINE");
  const own = sentFor("[ardia host] early tab switch failed", new ArdiaError("ERR_BAD_REPLY", "the reply isn't JSON"));
  assert.equal(own.error_type, "ArdiaError");
  assert.equal(own.error_message, "the reply isn't JSON");
  assert.equal(own.error_code, "ERR_BAD_REPLY");
});

test("a log line sends Ardia's fixed line and its id, never what was filled into it, and keeps the full line on this Mac", () => {
  const line = "[automation] download SecretProject wasn't moved (no space on SecretDisk); it is at /Users/me/Downloads/SecretProject";
  recordLog("warn", [line]);
  client.saveQueueNow();
  const log = queued().logs.at(-1);
  assert.equal(log.body.stringValue, "[automation] download {} wasn't moved ({}){}");
  assert.match(attributesOf(log).log_template, /^[0-9a-f]{8}$/);
  assert.doesNotMatch(JSON.stringify(log), /SecretProject|SecretDisk|\/Users\/me/);
  local.flushLocal();
  const record = stub.telemetryLocal.records().findLast((r) => r.kind === "log");
  assert.equal(record.message, "[automation] download {} wasn't moved ({}){}");
  assert.equal(record.text, line);
});

test("a wrapper's fixed words are part of the line, and the error text it adds is not", () => {
  recordLog("warn", ["[engine] sync delete: Couldn't delete the password for alice@example.com on bank.example"]);
  client.saveQueueNow();
  const log = queued().logs.at(-1);
  assert.equal(log.body.stringValue, "[engine] sync delete: {}");
  assert.doesNotMatch(JSON.stringify(log), /alice|bank/);
});

test("a line that isn't one of Ardia's own is sent as unlisted, with no text and no id", () => {
  recordLog("warn", ["A page said: my private diary entry", new SyntaxError("x")]);
  client.saveQueueNow();
  const log = queued().logs.at(-1);
  assert.equal(log.body.stringValue, "unlisted");
  assert.ok(!("log_template" in attributesOf(log)));
  assert.doesNotMatch(JSON.stringify(log), /diary/);
});

test("the distinct log lines are still capped at 40", () => {
  for (const [, template] of LOG_TEMPLATES.slice(0, 60)) recordLog("error", [template.replaceAll("{}", "x"), new Error("x")]);
  client.saveQueueNow();
  assert.equal(queued().logs.length, 40);
});
