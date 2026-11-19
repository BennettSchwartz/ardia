import assert from "node:assert/strict";
import { after, test } from "node:test";

const folder = new Map();
let ids = 0;
globalThis.acTestNativeModules = {
  ArdiaSync: {
    newDeviceId: () => `dev${++ids}`,
    deviceName: () => "Test Mac",
    createPhrase: async () => true,
    createChain: async () => {},
    unlock: async () => true,
    forget: async () => {},
    chainStatus: async () => "ok",
    write: async (_folder, scope, payload) => {
      const id = `f${folder.size + 1}`;
      folder.set(id, { scope, payload });
      return id;
    },
    read: async (_folder, scope, known) => {
      const here = [...folder].filter(([, f]) => f.scope === scope);
      return { files: here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload })), pending: [], damaged: [], present: here.map(([id]) => id) };
    },
    remove: async (_folder, _scope, list) => list.forEach((id) => folder.delete(id)),
    sealLocal: async (text) => `sealed:${text}`,
    openLocal: async (sealed) => (sealed.startsWith("sealed:") ? sealed.slice(7) : null),
    readPasswords: async () => null,
  },
};

const stub = await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const sync = await import("../sync/engine.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
after(() => {
  S().updateSettings({ cliControl: false });
  void sync.stopSync();
});
let nextId = 0;

async function call(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 41, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 500 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 41); i++) await tick();
  const replies = stub.controlSocket.replies.slice(before).filter((r) => r.connection === 41);
  assert.equal(replies.length, 1, `one reply to ${method}`);
  return JSON.parse(replies[0].line);
}
const ok = async (method, params) => {
  const reply = await call(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const code = async (method, params) => (await call(method, params)).error?.code;

test("sync writes: refused while sync is off, then the same switches Settings has", async () => {
  S().hydrate({});
  useBrowser.setState({ bookmarksReady: { "": true } });
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  const windowId = S().createWindow({ url: "https://a.example/" });
  const tab = S().windows[windowId].activeTabIds[S().windows[windowId].profileId];

  assert.equal(await code("sync.now"), "refused");
  assert.equal(await code("sync.setType", { type: "history", on: false }), "refused");
  assert.equal(await code("sync.sendTab", { tab, device: "x" }), "refused");

  sync.startSync();
  assert.ok("ok" in (await sync.turnOnSync("/sync")));
  const now = await ok("sync.now");
  assert.ok(["updated", "updating"].includes(now.status), now.status);

  assert.equal((await ok("sync.setType", { type: "history", on: false })).types.history, false);
  assert.equal(sync.useSync.getState().types.history, false);
  assert.equal((await ok("sync.setType", { type: "history", on: true })).types.history, true);

  await sync.syncNow();
  assert.ok(sync.useSync.getState().profiles.default, "the default profile links on its first sync");
  assert.equal((await ok("sync.setProfile", { profile: "default", on: false })).profiles.default.enabled, false);
  assert.equal(await code("sync.setOpenTabs", { profile: "default", on: true }), "refused", "the profile doesn't sync");
  await ok("sync.setProfile", { profile: "default", on: true });
  await ok("sync.setOpenTabs", { profile: "default", on: true });
  assert.equal(S().profiles.default.syncTabs, true);
  await ok("sync.setOpenTabs", { profile: "default", on: false });
  assert.equal(await code("sync.setProfile", { profile: "nope", on: true }), "no_window");

  assert.deepEqual(await ok("sync.devices"), [], "no other device takes tabs yet");
  assert.equal(await code("sync.sendTab", { tab, device: "dev-elsewhere" }), "no_window");
  const blank = S().newTab(windowId, { url: "about:blank" });
  assert.equal(await code("sync.sendTab", { tab: blank, device: "dev-elsewhere" }), "refused", "only web pages are sent");
});
