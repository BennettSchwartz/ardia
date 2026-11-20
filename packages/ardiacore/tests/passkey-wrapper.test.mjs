import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../ios/passkey_wrapper.js", import.meta.url), "utf8");
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

function page({ engine = "chromium", top = true, protocol = "https:" } = {}) {
  const calls = { get: 0, create: 0, uvpaa: 0 };
  const posted = [];
  const webkitPosts = [];
  let webkitAnswer = () => ({ fallThrough: true });
  class CredentialsContainer {}
  CredentialsContainer.prototype.get = function get() {
    calls.get++;
    return Promise.resolve("native-get");
  };
  CredentialsContainer.prototype.create = function create() {
    calls.create++;
    return Promise.resolve("native-create");
  };
  class PublicKeyCredential {}
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => {
    calls.uvpaa++;
    return Promise.resolve(false);
  };
  class AuthenticatorAssertionResponse {}
  class AuthenticatorAttestationResponse {}
  const window = {
    CredentialsContainer,
    PublicKeyCredential,
    AuthenticatorAssertionResponse,
    AuthenticatorAttestationResponse,
    DOMException: class DOMException extends Error {
      constructor(message, name) {
        super(message);
        this.name = name;
      }
    },
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    webkit: engine === "webkit" ? { messageHandlers: { ardiaPasskeys: { postMessage: (m) => (webkitPosts.push(m), Promise.resolve(webkitAnswer(m))) } } } : undefined,
  };
  window.window = window;
  window.top = top ? window : {};
  const context = {
    window,
    location: { protocol },
    document: { prerendering: false },
    crypto: { randomUUID: () => "nonce-" + Math.random().toString(36).slice(2) },
    Promise,
    ArrayBuffer,
    Uint8Array,
    Reflect,
    Object,
    JSON,
    Array,
    Map,
    Number,
    String,
    Math,
    Date,
    setTimeout,
    navigator: {},
  };
  const install = runInNewContext(source, context);
  const receive = install((kind, json) => posted.push({ kind, data: JSON.parse(json) }), engine);
  const credentials = Object.create(CredentialsContainer.prototype);
  return { window, receive, credentials, calls, posted, webkitPosts, answerWebKit: (fn) => (webkitAnswer = fn) };
}

const getOptions = () => ({ publicKey: { challenge: new Uint8Array([1, 2, 3]), rpId: "github.com", allowCredentials: [{ type: "public-key", id: new Uint8Array([9]) }] } });
const assertionReply = {
  id: b64url([7, 7]),
  rawId: b64url([7, 7]),
  type: "public-key",
  response: { clientDataJSON: b64url(Buffer.from("{}")), authenticatorData: b64url([1, 2]), signature: b64url([3, 4]), userHandle: b64url([5]) },
  clientExtensionResults: {},
};

test("the wrapper stays out of sub-frames and non-web pages", () => {
  const frame = page({ top: false });
  assert.equal(frame.window.CredentialsContainer.prototype.get.name, "get");
  assert.equal(frame.receive("passkeyConfig", "{}"), false);
  const file = page({ protocol: "file:" });
  assert.equal(file.receive("passkeyReply", "{}"), false);
});

test("with the provider off, requests go straight to the browser", async () => {
  const p = page();
  p.receive("passkeyConfig", JSON.stringify({ on: false }));
  assert.equal(await p.credentials.get(getOptions()), "native-get");
  assert.equal(p.calls.get, 1);
  assert.equal(p.posted.length, 0);
  assert.equal(await p.credentials.get({ password: true }), "native-get");
});

test("a request asks native, confirms with its nonce, and answers with a PublicKeyCredential", async () => {
  const p = page();
  p.receive("passkeyConfig", JSON.stringify({ on: true }));
  const pending = p.credentials.get(getOptions());
  const request = p.posted.find((m) => m.kind === "passkeyRequest").data;
  assert.equal(request.op, "get");
  assert.equal(request.options.publicKey.challenge, b64url([1, 2, 3]));
  assert.deepEqual(request.options.publicKey.allowCredentials, [{ type: "public-key", id: b64url([9]) }]);
  p.receive("passkeyAck", JSON.stringify({ nonce: "someone-else", id: request.id }));
  assert.equal(p.posted.filter((m) => m.kind === "passkeyAckOk").length, 0);
  p.receive("passkeyAck", JSON.stringify({ nonce: request.nonce, id: request.id }));
  assert.deepEqual(p.posted.at(-1), { kind: "passkeyAckOk", data: { nonce: request.nonce, id: request.id, pending: true } });
  p.receive("passkeyReply", JSON.stringify({ nonce: "other-document", id: request.id, reply: { error: "NotAllowedError" } }));
  p.receive("passkeyReply", JSON.stringify({ nonce: request.nonce, id: request.id, reply: { handled: assertionReply } }));
  const credential = await pending;
  assert.ok(credential instanceof p.window.PublicKeyCredential);
  assert.ok(credential.response instanceof p.window.AuthenticatorAssertionResponse);
  assert.equal(credential.id, assertionReply.id);
  assert.deepEqual([...new Uint8Array(credential.response.signature)], [3, 4]);
  assert.equal(credential.toJSON().response.userHandle, assertionReply.response.userHandle);
  assert.equal(JSON.stringify(credential.getClientExtensionResults()), "{}");
  assert.ok(Object.hasOwn(credential, "rawId") && Object.hasOwn(credential, "type"));
  assert.equal(p.calls.get, 0);
});

test("fall-through calls the browser's own method, errors reject, and abort settles once without falling through", async () => {
  const p = page();
  p.receive("passkeyConfig", JSON.stringify({ on: true }));
  const first = p.credentials.get(getOptions());
  const r1 = p.posted.at(-1).data;
  p.receive("passkeyAck", JSON.stringify({ nonce: r1.nonce, id: r1.id }));
  p.receive("passkeyReply", JSON.stringify({ nonce: r1.nonce, id: r1.id, reply: { fallThrough: true } }));
  assert.equal(await first, "native-get");

  const second = p.credentials.get(getOptions());
  const r2 = p.posted.at(-1).data;
  p.receive("passkeyReply", JSON.stringify({ nonce: r2.nonce, id: r2.id, reply: { error: "NotAllowedError" } }));
  await assert.rejects(second, (e) => e.name === "NotAllowedError");

  const controller = new AbortController();
  const options = { ...getOptions(), signal: controller.signal };
  const third = p.credentials.get(options);
  const r3 = p.posted.at(-1).data;
  controller.abort();
  await assert.rejects(third, (e) => e.name === "AbortError");
  assert.deepEqual(p.posted.at(-1), { kind: "passkeyCancel", data: { nonce: r3.nonce, id: r3.id } });
  p.receive("passkeyReply", JSON.stringify({ nonce: r3.nonce, id: r3.id, reply: { fallThrough: true } }));
  assert.equal(p.calls.get, 1);
});

test("a request native never confirms falls through after three seconds", async () => {
  const p = page();
  p.receive("passkeyConfig", JSON.stringify({ on: true }));
  const started = Date.now();
  assert.equal(await p.credentials.get(getOptions()), "native-get");
  assert.ok(Date.now() - started >= 2900);
});

test("in WebKit the reply handler answers, and fall-through is NotAllowedError, never the native call", async () => {
  const p = page({ engine: "webkit" });
  p.answerWebKit(() => ({ fallThrough: true }));
  await assert.rejects(p.credentials.get(getOptions()), (e) => e.name === "NotAllowedError");
  assert.equal(p.calls.get, 0);
  assert.equal(p.webkitPosts[0].kind, "get");
  p.answerWebKit(() => ({ handled: assertionReply }));
  const credential = await p.credentials.get(getOptions());
  assert.ok(credential instanceof p.window.PublicKeyCredential);
  p.answerWebKit(() => ({ fallThrough: true }));
  assert.equal(await p.window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), false);
  assert.equal(p.calls.uvpaa, 0);
});
