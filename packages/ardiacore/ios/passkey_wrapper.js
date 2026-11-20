(function (post, engine) {
  "use strict";
  const idle = () => false;
  if (window !== window.top || !/^https?:$/.test(location.protocol)) return idle;

  const apply = Reflect.apply;
  const { defineProperty, create, freeze } = Object;
  const { stringify: toJSON, parse: fromJSON } = JSON;
  let container = null;
  let PKC = null;
  let nativeGet = null;
  let nativeCreate = null;
  let nativeUvpaa = null;
  let AssertionResponse = null;
  let AttestationResponse = null;
  const toBase64 = window.btoa.bind(window);
  const fromBase64 = window.atob.bind(window);
  const NativeDOMException = window.DOMException;
  const NativePromise = Promise;
  const ArrayBufferCtor = ArrayBuffer;
  const Uint8 = Uint8Array;
  const isView = ArrayBuffer.isView;
  const messages = engine === "webkit" ? window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ardiaPasskeys : null;
  const postToWebKit = messages ? messages.postMessage.bind(messages) : null;
  if (engine === "webkit" && !postToWebKit) return idle;
  const nonce = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2) + String(Date.now());
  let enabled = engine === "webkit" ? true : null;
  const fallBack = (original, self, args) =>
    engine === "webkit"
      ? NativePromise.reject(new NativeDOMException("The operation either timed out or was not allowed.", "NotAllowedError"))
      : apply(original, self, args);
  let seq = 0;
  const pending = new Map();

  const encode = (value) => {
    const bytes = value instanceof ArrayBufferCtor ? new Uint8(value) : isView(value) ? new Uint8(value.buffer, value.byteOffset, value.byteLength) : null;
    if (!bytes) return null;
    let text = "";
    for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return toBase64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const decode = (text) => {
    const binary = fromBase64(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };
  const descriptors = (list) =>
    Array.isArray(list) ? list.slice(0, 65).map((d) => ({ type: "public-key", id: d && encode(d.id) })) : undefined;
  const requestOptions = (op, options) => {
    const pk = options.publicKey;
    const challenge = encode(pk.challenge);
    if (!challenge) return null;
    const publicKey = { challenge, timeout: typeof pk.timeout === "number" ? pk.timeout : undefined };
    if (op === "get") {
      if (typeof pk.rpId === "string") publicKey.rpId = pk.rpId;
      publicKey.allowCredentials = descriptors(pk.allowCredentials);
      publicKey.userVerification = pk.userVerification;
    } else {
      const user = pk.user || {};
      publicKey.rp = { id: pk.rp && typeof pk.rp.id === "string" ? pk.rp.id : undefined, name: pk.rp && String(pk.rp.name || "") };
      publicKey.user = { id: encode(user.id), name: String(user.name || ""), displayName: String(user.displayName || "") };
      publicKey.pubKeyCredParams = Array.isArray(pk.pubKeyCredParams) ? pk.pubKeyCredParams.slice(0, 32).map((p) => ({ type: "public-key", alg: Number(p && p.alg) })) : [];
      publicKey.excludeCredentials = descriptors(pk.excludeCredentials);
      const selection = pk.authenticatorSelection || {};
      publicKey.authenticatorSelection = { authenticatorAttachment: selection.authenticatorAttachment, residentKey: selection.residentKey, userVerification: selection.userVerification };
      publicKey.extensions = { credProps: !!(pk.extensions && pk.extensions.credProps) };
    }
    return { mediation: typeof options.mediation === "string" ? options.mediation : undefined, publicKey };
  };

  const own = (target, values) => {
    for (const name in values) defineProperty(target, name, { value: values[name], enumerable: typeof values[name] !== "function", configurable: true });
    return target;
  };
  const credentialFrom = (op, result) => {
    const r = result.response;
    const raw = decode(result.rawId);
    const response = create((op === "get" ? AssertionResponse : AttestationResponse).prototype);
    const clientDataJSON = decode(r.clientDataJSON);
    if (op === "get") {
      own(response, { clientDataJSON, authenticatorData: decode(r.authenticatorData), signature: decode(r.signature), userHandle: r.userHandle ? decode(r.userHandle) : null });
    } else {
      const authData = decode(r.authenticatorData);
      const publicKey = decode(r.publicKey);
      own(response, {
        clientDataJSON,
        attestationObject: decode(r.attestationObject),
        getTransports: () => ["internal"],
        getAuthenticatorData: () => authData.slice(0),
        getPublicKey: () => publicKey.slice(0),
        getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
      });
    }
    const extensions = freeze(Object.assign({}, result.clientExtensionResults || {}));
    const credential = create(PKC.prototype);
    own(credential, {
      id: result.id,
      rawId: raw,
      type: "public-key",
      authenticatorAttachment: "platform",
      response,
      getClientExtensionResults: () => Object.assign({}, extensions),
      toJSON: () => {
        const json = { id: result.id, rawId: result.rawId, type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: Object.assign({}, extensions) };
        json.response = op === "get"
          ? { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle || null }
          : { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, authenticatorData: r.authenticatorData, transports: ["internal"], publicKey: r.publicKey, publicKeyAlgorithm: r.publicKeyAlgorithm };
        return json;
      },
    });
    return credential;
  };

  const ask = (op, payload, signal) =>
    new NativePromise((resolve) => {
      const id = ++seq;
      const entry = { resolve, acked: false };
      pending.set(id, entry);
      const settle = (reply) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve(reply);
      };
      entry.settle = settle;
      if (signal) {
        if (signal.aborted) return settle({ aborted: true });
        signal.addEventListener("abort", () => {
          if (!pending.has(id)) return;
          if (postToWebKit) postToWebKit({ kind: "cancel", id, nonce });
          else post("passkeyCancel", toJSON({ nonce, id }));
          settle({ aborted: true });
        }, { once: true });
      }
      if (postToWebKit) {
        postToWebKit({ kind: op, id, nonce, options: toJSON(payload) }).then((reply) => settle(reply || { fallThrough: true }), () => settle({ fallThrough: true }));
      } else {
        post("passkeyRequest", toJSON({ nonce, id, op, options: payload }));
        setTimeout(() => {
          if (pending.has(id) && !entry.acked) settle({ fallThrough: true });
        }, 3000);
      }
    });

  const run = (op, original, self, args) => {
    const options = args[0];
    const isPasskey = options && typeof options === "object" && options.publicKey && typeof options.publicKey === "object";
    if (!isPasskey || enabled === false || document.prerendering) return apply(original, self, args);
    const payload = requestOptions(op, options);
    if (!payload) return fallBack(original, self, args);
    return ask(op, payload, options.signal).then((reply) => {
      if (reply.aborted) throw new NativeDOMException("The operation was aborted.", "AbortError");
      if (reply.handled) return credentialFrom(op, reply.handled);
      if (reply.error) throw new NativeDOMException(reply.message || "The operation either timed out or was not allowed.", reply.error);
      return fallBack(original, self, args);
    });
  };

  const disguise = (original, name, body) => {
    const wrapped = {
      [name]() {
        return body(this, arguments);
      },
    }[name];
    defineProperty(wrapped, "length", { value: original.length });
    return wrapped;
  };
  const install = () => {
    if (container) return true;
    const proto = window.CredentialsContainer && window.CredentialsContainer.prototype;
    const credential = window.PublicKeyCredential;
    if (!proto || typeof proto.get !== "function" || typeof credential !== "function") return false;
    container = proto;
    PKC = credential;
    nativeGet = proto.get;
    nativeCreate = proto.create;
    nativeUvpaa = credential.isUserVerifyingPlatformAuthenticatorAvailable;
    AssertionResponse = window.AuthenticatorAssertionResponse;
    AttestationResponse = window.AuthenticatorAttestationResponse;
    const wrapped = {
      get: disguise(nativeGet, "get", (self, args) => run("get", nativeGet, self, args)),
      create: disguise(nativeCreate, "create", (self, args) => run("create", nativeCreate, self, args)),
      uvpaa: disguise(nativeUvpaa, "isUserVerifyingPlatformAuthenticatorAvailable", (self, args) => {
        if (enabled !== true) return apply(nativeUvpaa, self, args);
        return ask("uvpaa", {}, null).then((reply) => (reply.handled === true ? true : engine === "webkit" ? false : apply(nativeUvpaa, self, args)));
      }),
    };
    defineProperty(proto, "get", { value: wrapped.get, writable: true, configurable: true });
    defineProperty(proto, "create", { value: wrapped.create, writable: true, configurable: true });
    defineProperty(credential, "isUserVerifyingPlatformAuthenticatorAvailable", { value: wrapped.uvpaa, writable: true, configurable: true });
    return true;
  };
  if (!install()) {
    const retry = () => install();
    if (typeof queueMicrotask === "function") queueMicrotask(retry);
    setTimeout(retry, 0);
    if (window.document && typeof window.document.addEventListener === "function") {
      window.document.addEventListener("readystatechange", retry);
      window.document.addEventListener("DOMContentLoaded", retry, { once: true });
    }
  }

  const handlers = {
    passkeyConfig: (config) => {
      enabled = !!(config && config.on);
    },
    passkeyAck: (message) => {
      if (!message || message.nonce !== nonce) return;
      const entry = pending.get(message.id);
      if (entry) entry.acked = true;
      post("passkeyAckOk", toJSON({ nonce, id: message.id, pending: !!entry }));
    },
    passkeyReply: (message) => {
      if (!message || message.nonce !== nonce) return;
      const entry = pending.get(message.id);
      if (entry) entry.settle(message.reply || { fallThrough: true });
    },
  };
  return (kind, json) => {
    const handler = handlers[kind];
    if (!handler) return false;
    try {
      handler(typeof json === "string" ? fromJSON(json) : json);
    } catch (e) {}
    return true;
  };
})
