import assert from "node:assert/strict";
import { after, test } from "node:test";

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  const timer = realSetTimeout(callback, ms, ...args);
  return ms >= 1_000 ? timer.unref() : timer;
};
globalThis.__DEV__ = false;
globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(Date.now()), 0);
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const presses = await import("./tabPresses.ts");
const { takeLiveGithubCounts } = await import("./liveGithub.ts");
const { takeFindCounts } = await import("./findCounts.ts");
const { takeTabSleepCounts } = await import("./tabSleepCounts.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { createGithubClient } = await import("../live/githubClient.ts");
const { LiveError } = await import("../live/types.ts");
const { runCommand } = await import("../commands/commands.ts");
const { openExternalUrls } = await import("../littleArdia/actions.ts");
const { dropTabsInProfile } = await import("../browser/actions.ts");
const loading = await import("../profiles/profileLoading.ts");
const { checkIdleProfiles, profileUnloadingForTests, startProfileUnloading } = await import("../profiles/profileUnloading.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const sharing = (on) => {
  client.loadChoice();
  client.setSharing(on, "settings");
};
const flipSharing = () => {
  sharing(false);
  sharing(true);
};
const queued = () => JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events;
const usageSince = async (seen) => {
  usage.emitWindowUsage(client.consentNow());
  await client.saveQueueNow();
  return queued().slice(seen).filter((e) => e.event === "usage_counts");
};
const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test("GitHub requests a folder refresh made before a consent change aren't counted when their rate-limit answers arrive after it", async () => {
  sharing(true);
  let answer = () => {};
  const answered = new Promise((resolve) => (answer = resolve));
  const send = async () => {
    await answered;
    throw new LiveError("rateLimited", "Rate Limit Exceeded");
  };
  const github = createGithubClient(send, () => 1_800_000_000_000);
  const refreshing = github.fetchFolder("t", { id: "f", filters: { authored: true, reviewRequests: true } }, true);
  await new Promise((resolve) => setImmediate(resolve));
  flipSharing();
  takeLiveGithubCounts();
  answer();
  await assert.rejects(refreshing, (e) => e.kind === "rateLimited");
  const counts = takeLiveGithubCounts();
  assert.deepEqual([counts.live_github_requests, counts.live_github_requests_held, counts.live_github_rate_limited], [0, 0, 0]);
});

test("Use Selection for Find opened before a consent change isn't counted when the page's selection arrives after it", async () => {
  sharing(true);
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://example.com/" });
  const tabId = S().windows[windowId].tabIds[0];
  let reply = () => {};
  webviews.set(tabId, { evaluate: () => new Promise((resolve) => (reply = resolve)) });
  takeFindCounts();
  runCommand({ command: "useSelectionForFind", arg: null, windowId });
  flipSharing();
  takeFindCounts();
  reply("needle");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(S().find[tabId]?.open, true, "the bar still opens with the selection");
  assert.equal(takeFindCounts().find_opens, 0);
  webviews.delete(tabId);
});

test("an idle profile unload that started before a consent change isn't counted when it finishes after the settle wait", async () => {
  sharing(true);
  let clock = 0;
  profileUnloadingForTests(() => clock);
  startProfileUnloading();
  stub.loadedEngineProfiles.clear();
  for (const engine of ["", "work", "play"]) stub.loadedEngineProfiles.add(engine);
  stub.profilesLoadedCall.known = true;
  stub.idleProfileUnloads.clear();
  const tab = (id, profileId, url) => ({ id, windowId: "w1", profileId, url, title: id, favicon: null, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null, page: { kind: "loaded", nav: { url, seq: 1 } }, openerId: null, createdAt: 0, lastActiveAt: 0 });
  const tabs = [tab("t-work", "work", "https://work.example/"), tab("t-play", "play", "https://play.example/")];
  S().hydrate({
    profiles: { default: PERSONAL, work: { ...PERSONAL, id: "work", name: "Work", createdAt: 1 }, play: { ...PERSONAL, id: "play", name: "Play", createdAt: 2 } },
    profileOrder: ["default", "work", "play"], settings: { unloadProfilesAfter: "5m", memorySaver: true },
    windows: { w1: { id: "w1", profileId: "work", kind: "main", tabIds: tabs.map((t) => t.id), activeTabIds: { work: "t-work", play: "t-play" }, sidebarOpen: true, frame: null, createdAt: 0 } },
    tabs: Object.fromEntries(tabs.map((t) => [t.id, t])), focusedWindowId: "w1",
  });
  const stop = loading.startProfileLoading();
  await until(() => loading.profileOpened("play"), "the engine's loaded profiles");
  stub.idleProfileUnloads.set("play", { status: "pending", tabs: ["t-play"], heldBy: "sleeping" });
  await checkIdleProfiles(clock);
  let settle = null;
  globalThis.setTimeout = (callback, ms, ...args) => (ms === 5_000 ? ((settle = callback), 0) : realSetTimeout(callback, ms, ...args));
  takeTabSleepCounts();
  const checking = checkIdleProfiles(clock + 5 * 60_000);
  await until(() => settle, "the settle wait");
  globalThis.setTimeout = realSetTimeout;
  flipSharing();
  takeTabSleepCounts();
  stub.idleProfileUnloads.set("play", { status: "pending", tabs: ["t-play"] });
  settle();
  await checking;
  assert.equal(loading.profileOpened("play"), false, "the profile still unloads");
  assert.equal(takeTabSleepCounts().profiles_unloaded, 0);
  stop();
});

test("a link from another app that arrives before a consent change isn't counted when its route answer comes back after it", async () => {
  sharing(true);
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], windows: {}, tabs: {} });
  const main = S().createWindow({ url: "https://b.example/" });
  S().setFocusedWindow(main);
  S().updateSettings({ openLinksInLittleArdia: false });
  await usageSince(0);
  const seen = queued().length;
  openExternalUrls(["https://one.example/"]);
  flipSharing();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(S().windows[main].tabIds.some((id) => S().tabs[id].url === "https://one.example/"), "the link still opens");
  const counted = (await usageSince(seen)).filter((e) => (e.properties.external_links_tab_setting_off ?? 0) > 0);
  assert.deepEqual(counted, []);
});

test("a tab dragged onto another profile isn't counted as a drop when the drag began before a consent change", async () => {
  sharing(true);
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const b = S().newTab(w, { url: "https://b.com/", background: true });
  const work = S().createProfile({ name: "Work" });
  S().updateSettings({ warnBeforeMovingTabsToProfile: false });
  const drag = {};
  presses.noteDragBegan(drag);
  flipSharing();
  const before = presses.devTabPresses().drops_other_profile;
  const placed = await dropTabsInProfile([b], work, { type: "none" }, "default", false, drag);
  assert.ok(placed, "the tab still moves");
  assert.equal(S().tabs[b].profileId, work);
  assert.equal(presses.devTabPresses().drops_other_profile - before, 0);
});
