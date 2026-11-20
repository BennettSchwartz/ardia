import assert from "node:assert/strict";
import test from "node:test";
import { CHECK_EVERY_MS, FIRST_CHECK_AFTER_MS, UPDATE_CHECK_LOCK, UPDATE_INSTALL_LOCK, UPDATE_PREFERENCES, installsUpdates, linuxSwitchesFetch, linuxUpdater, scheduleUpdateChecks } from "./hostUpdates.ts";
import { SELF_UPDATE_METHODS } from "./hostCapabilities.ts";
import { compareVersions, linuxReleases, newestRelease } from "./updateReleases.ts";
import { takeUpdateCounts } from "../../browser/src/state/telemetry/updateCounts.ts";
import { setConsentPeriod } from "../../browser/src/state/telemetry/consentPeriod.ts";

setConsentPeriod(true, "host-updates-test");

const page = (tag) => `https://github.com/ardia-browser/ardia/releases/tag/${tag}`;
const release = (tag, { prerelease = false, draft = false, assets = [`Ardia-${tag.replace(/^v/, "")}-linux-x64.tar.xz`] } = {}) =>
  ({ tag_name: tag, html_url: page(tag), prerelease, draft, assets: assets.map((name) => ({ name })) });
const LIST = [
  release("engine-0be922b5d707", { prerelease: true, assets: ["ArdiaCore-0be922b5d707-linux-x64.tar.xz"] }),
  release("v0.2.47-nightly.3", { prerelease: true }),
  release("v0.2.47-nightly.2", { prerelease: true }),
  release("v0.2.46", { assets: ["Ardia-0.2.46.dmg", "Ardia-0.2.46-linux-x64.tar.xz", "Ardia-0.2.46-linux-x64.deb"] }),
  release("v0.2.48", { assets: ["Ardia-0.2.48.dmg"] }),
  release("v0.2.49", { draft: true }),
  { ...release("v0.2.50"), html_url: "https://evil.example/ardia" },
];

test("release tags compare by version, nightly builds before their stable release", () => {
  assert.equal(compareVersions("0.2.46", "0.2.46-nightly.9"), 1);
  assert.equal(compareVersions("0.2.47-nightly.2", "0.2.46"), 1);
  assert.equal(compareVersions("0.2.47-nightly.10", "0.2.47-nightly.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.2.46", "0.2.46"), 0);
});

test("only published releases with a Linux package and a GitHub release page count, newest per channel", () => {
  const releases = linuxReleases(JSON.stringify(LIST));
  assert.deepEqual(releases.map((r) => r.version), ["0.2.47-nightly.3", "0.2.47-nightly.2", "0.2.46"]);
  assert.equal(newestRelease(releases, "stable")?.version, "0.2.46");
  assert.equal(newestRelease(releases, "nightly")?.version, "0.2.47-nightly.3");
  assert.throws(() => linuxReleases("{}"), /not a list/);
});

function harness({ version = "0.2.45", body = JSON.stringify(LIST), status = 200, launch = {}, capabilities = ["ArdiaUpdates.releases"], disk, kind, download = (v) => ({ ok: true, dir: `/data/Updates/${v}` }), install = (v) => ({ ok: true, version: v }), locks } = {}) {
  const docs = new Map();
  const seen = { asked: [], told: [], offered: [], offeredInstalls: [], ready: [], managed: [], opened: [], requests: 0, calls: [] };
  const host = {
    bootstrap: { launchConfig: launch, capabilities: kind === undefined ? capabilities : [...capabilities, ...SELF_UPDATE_METHODS] },
    invoke: async (method, { args }) => {
      seen.calls.push(args.length ? `${method} ${args.join(" ")}` : method);
      if (method === "ArdiaUpdates.installKind") return kind;
      if (method === "ArdiaUpdates.download") return download(...args);
      if (method === "ArdiaUpdates.install") return install(...args);
      if (method === "ArdiaUpdates.restart") return true;
      assert.equal(method, "ArdiaUpdates.releases");
      seen.requests++;
      return { status, body };
    },
  };
  const updater = linuxUpdater({
    host,
    appVersion: () => version,
    read: (name) => docs.get(name) ?? null,
    write: (name, contents) => {
      docs.set(name, contents);
      disk?.set(name, contents);
    },
    refresh: async (name) => {
      if (disk?.has(name)) docs.set(name, disk.get(name));
    },
    ask: async (r, current, failed) => (seen.asked.push(failed ? [r.version, current, "failed"] : [r.version, current]), true),
    tell: async (title) => void seen.told.push(title),
    offer: (r, failed) => void seen.offered.push(failed ? `${r.version} failed` : r.version),
    offerInstall: (r, run) => void seen.offeredInstalls.push({ version: r.version, run }),
    ready: (v, restart) => void seen.ready.push({ version: v, restart }),
    managed: async (r, current, asked) => void seen.managed.push([r.version, current, asked]),
    open: (url) => void seen.opened.push(url),
    locks,
    now: () => 1_000,
  });
  const updates = () => seen.calls.filter((call) => /^ArdiaUpdates\.(download|install|restart)\b(?!Kind)/.test(call));
  return { updater, docs, seen, host, updates };
}

const settled = async (until) => {
  for (let i = 0; i < 100 && !until(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(until(), "the update flow settled");
};

const SELF_UPDATE_COUNTS = (counts) => Object.fromEntries(Object.entries(counts).filter(([field, n]) => /^update_(downloads?|installs?|install_failures|download_failures|restarts)/.test(field) && n));

test("Check Now finds the newest stable Linux release, offers its page and records the check", async () => {
  takeUpdateCounts();
  const { updater, docs, seen } = harness();
  await updater.methods.checkForUpdates();
  assert.deepEqual(seen.asked, [["0.2.46", "0.2.45"]]);
  assert.deepEqual(seen.opened, [page("v0.2.46")]);
  const state = await updater.methods.updaterState();
  assert.equal(state.configured, true);
  assert.equal(state.lastCheck, 1_000);
  assert.deepEqual(state.switchCheck, { phase: "found", channel: "stable", version: "0.2.46" });
  assert.equal(state.automaticDownloads, false);
  assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).lastCheck, 1_000);
  const counts = takeUpdateCounts();
  assert.equal(counts.update_checks_asked, 1);
  assert.equal(counts.update_checks_found, 1);
  assert.equal(counts.update_release_page_opens, 1);
});

test("a nightly build follows nightly releases, and switching channel checks again", async () => {
  const { updater, seen } = harness({ version: "0.2.47-nightly.2" });
  assert.equal((await updater.methods.updaterState()).channel, "nightly");
  await updater.methods.checkForUpdates();
  assert.deepEqual(seen.asked.at(-1), ["0.2.47-nightly.3", "0.2.47-nightly.2"]);
  await updater.methods.setUpdateChannel("stable");
  assert.equal((await updater.methods.updaterState()).channel, "stable");
  assert.deepEqual(seen.told, ["Ardia is up to date"], "0.2.46 is older than this nightly");
});

test("an automatic check offers a new release once and never opens a dialog", async () => {
  const { updater, seen } = harness();
  await updater.check(false);
  await updater.check(false);
  assert.deepEqual(seen.offered, ["0.2.46"]);
  assert.deepEqual(seen.asked, []);
});

test("a failed check says so when asked, counts the failure and shows failed in Settings", async () => {
  takeUpdateCounts();
  const { updater, seen } = harness({ status: 0, body: "" });
  await updater.methods.checkForUpdates();
  assert.deepEqual(seen.told, ["Ardia couldn't check for updates"]);
  assert.equal((await updater.methods.updaterState()).switchCheck.phase, "failed");
  assert.equal(takeUpdateCounts().update_check_failures, 1);
});

test("a dev build without a release version isn't set up to update and never asks GitHub", async () => {
  const { updater, seen } = harness({ version: "157.0.8103.50" });
  assert.equal((await updater.methods.updaterState()).configured, false);
  await updater.methods.checkForUpdates();
  assert.equal(seen.requests, 0);
  assert.equal(await updater.checksByItself(), false);
});

test("automatic checks stay off in hidden instances and when turned off, and run in one window only", async () => {
  assert.equal(await harness({ launch: { background: true } }).updater.checksByItself(), false);
  const { updater } = harness();
  assert.equal(await updater.checksByItself(), true);
  await updater.methods.setAutomaticUpdateChecks(false);
  assert.equal(await updater.checksByItself(), false);
  const requested = [];
  const timers = { setTimeout: (fn, ms) => requested.push(["timeout", ms]), setInterval: (fn, ms) => requested.push(["interval", ms]) };
  scheduleUpdateChecks(updater, { locks: { request: (name, callback) => (requested.push(["lock", name]), callback(), new Promise(() => {})) }, timers });
  assert.deepEqual(requested, [["lock", UPDATE_CHECK_LOCK], ["timeout", FIRST_CHECK_AFTER_MS], ["interval", CHECK_EVERY_MS]]);
});

test("turning automatic checks off or switching channel in the Settings window reaches the window that checks, and its next check keeps both", async () => {
  const disk = new Map();
  const browser = harness({ disk });
  const settings = harness({ disk });
  assert.equal(await browser.updater.checksByItself(), true);
  await settings.updater.methods.setAutomaticUpdateChecks(false);
  assert.equal(await browser.updater.checksByItself(), false);
  await browser.updater.check(false);
  assert.equal(browser.seen.requests, 0, "a scheduled check reads the switch again before it asks GitHub");
  await settings.updater.methods.setUpdateChannel("nightly");
  assert.equal((await browser.updater.methods.updaterState()).channel, "nightly");
  await browser.updater.methods.checkForUpdates();
  assert.deepEqual(browser.seen.asked.at(-1), ["0.2.47-nightly.3", "0.2.45"]);
  const saved = JSON.parse(disk.get(UPDATE_PREFERENCES));
  assert.equal(saved.automaticChecks, false, "recording the check doesn't write the old switch back");
  assert.equal(saved.channel, "nightly");
  assert.equal(saved.lastCheck, 1_000);
});

test("the kill-switch file comes through the native host and every other fetch is left alone", async () => {
  const calls = [];
  const host = { bootstrap: { capabilities: ["ArdiaShell.fetchKillSwitches"] }, invoke: async (method) => (calls.push(method), { status: 200, body: "{\"version\":1,\"switches\":{}}" }) };
  const original = async (input) => new Response(`original ${input}`);
  const fetchFn = linuxSwitchesFetch(host, original);
  assert.equal(await (await fetchFn("https://ardia.dev/switches.json")).text(), "{\"version\":1,\"switches\":{}}");
  assert.equal(await (await fetchFn("https://example.com/")).text(), "original https://example.com/");
  assert.deepEqual(calls, ["ArdiaShell.fetchKillSwitches"]);
  const refused = linuxSwitchesFetch({ ...host, invoke: async () => ({ status: 0, body: "" }) }, original);
  await assert.rejects(refused("https://ardia.dev/switches.json"), TypeError);
});

test("the switch refresh through the native host updates the cached switches", async () => {
  globalThis.__DEV__ = false;
  await import("../../browser/src/test-native/index.ts");
  const { refreshSwitches, resetRefreshForTests } = await import("../../browser/src/platform/killSwitches.ts");
  resetRefreshForTests();
  const host = { bootstrap: { capabilities: [] }, invoke: async () => ({ status: 200, body: JSON.stringify({ version: 1, switches: { newTabPrewarm: false } }) }) };
  assert.equal(await refreshSwitches(linuxSwitchesFetch(host, async () => { throw new Error("the shell can't fetch"); })), "updated");
});

test("a launch started with --no-sandbox says why once, in the window that ran the launch, and counts it", async () => {
  const { noticeUnsandboxedLaunch, sandboxNotice } = await import("./sandboxNotice.ts");
  assert.equal(sandboxNotice(undefined), null);
  const reason = "Ardia was started with --no-sandbox";
  assert.equal(sandboxNotice(reason).message, "Ardia was started with --no-sandbox. Start Ardia without --no-sandbox to turn the sandbox back on.");
  assert.match(sandboxNotice("--no-sandbox was passed to chrome directly").message, /^--no-sandbox was passed to chrome directly\. Start Ardia without --no-sandbox/);
  takeUpdateCounts();
  const shown = [];
  const host = { bootstrap: { sandboxDecision: reason } };
  const noIntro = { open: () => false, closed: () => Promise.resolve() };
  assert.equal(await noticeUnsandboxedLaunch(host, "w1", Promise.resolve("alreadyDone"), (...args) => shown.push(args), noIntro), false);
  assert.equal(await noticeUnsandboxedLaunch({ bootstrap: {} }, "w1", Promise.resolve("ran"), (...args) => shown.push(args), noIntro), false);
  let close;
  const intro = { open: () => true, closed: () => new Promise((resolve) => (close = resolve)) };
  const pending = noticeUnsandboxedLaunch(host, "w1", Promise.resolve("ran"), (...args) => shown.push(args), intro);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shown, [], "the first-run onboarding covers toasts, so the notice waits for it to close");
  close();
  assert.equal(await pending, true);
  assert.deepEqual(shown.map(([windowId, title]) => [windowId, title]), [["w1", "Ardia is running without Chromium's sandbox"]]);
  assert.equal(takeUpdateCounts().launches_without_sandbox, 1);
});

test("only the telemetry leader counts login-password confirmations, by outcome, and polkit's are left out", async () => {
  const { countLoginPasswordChecks } = await import("./reauthCounts.ts");
  takeUpdateCounts();
  let emit;
  let leading = false;
  countLoginPasswordChecks(() => leading, (listener) => (emit = listener));
  emit({ method: "loginPassword", result: "granted" });
  leading = true;
  for (const result of ["granted", "denied", "denied", "cancelled", "unavailable"]) emit({ method: "loginPassword", result });
  emit({ method: "polkit", result: "granted" });
  const counts = takeUpdateCounts();
  assert.deepEqual([counts.login_password_checks_granted, counts.login_password_checks_denied, counts.login_password_checks_cancelled], [1, 2, 1]);
});

test("with self-update, an automatic check downloads and installs the release, says it's ready, and Check Now restarts", async () => {
  takeUpdateCounts();
  const { updater, docs, seen, host, updates } = harness({ kind: "deb" });
  assert.equal((await updater.methods.updaterState()).automaticDownloads, true, "self-update turns the shared toggle on by default");
  assert.equal(installsUpdates(host), true, "Settings shows Automatically update Ardia");
  await updater.check(false);
  assert.deepEqual(updates(), ["ArdiaUpdates.download 0.2.46", "ArdiaUpdates.install 0.2.46"]);
  assert.deepEqual(seen.ready.map((r) => r.version), ["0.2.46"]);
  assert.deepEqual([seen.asked, seen.offered, seen.opened], [[], [], []], "no release page while self-update works");
  const state = await updater.methods.updaterState();
  assert.deepEqual(state.switchCheck, { phase: "ready", channel: "stable", version: "0.2.46" });
  const saved = JSON.parse(docs.get(UPDATE_PREFERENCES));
  assert.equal(saved.installed, "0.2.46");
  assert.equal(saved.work, null);
  await updater.methods.checkForUpdates();
  assert.deepEqual(updates().at(-1), "ArdiaUpdates.restart");
  assert.equal(seen.requests, 1, "Restart to Update doesn't check again");
  seen.ready[0].restart();
  await settled(() => updates().filter((call) => call === "ArdiaUpdates.restart").length === 2);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), { update_downloads_started: 1, update_downloads_finished: 1, update_installs_deb: 1, update_restarts: 2 });
});

test("Check Now installs the update the same way, without a dialog, and answers once the download starts so Settings can follow it", async () => {
  takeUpdateCounts();
  let finishDownload;
  const { updater, seen, updates } = harness({ kind: "tarball", download: (v) => new Promise((resolve) => (finishDownload = () => resolve({ ok: true, dir: `/data/Updates/${v}` }))) });
  await updater.methods.checkForUpdates();
  const state = await updater.methods.updaterState();
  assert.deepEqual([state.switchCheck, state.sessionInProgress], [{ phase: "downloading", channel: "stable", version: "0.2.46" }, true]);
  finishDownload();
  await settled(() => seen.ready.length === 1);
  assert.deepEqual(updates(), ["ArdiaUpdates.download 0.2.46", "ArdiaUpdates.install 0.2.46"]);
  assert.deepEqual(seen.ready.map((r) => r.version), ["0.2.46"]);
  assert.deepEqual(seen.asked, []);
  assert.equal(takeUpdateCounts().update_installs_tarball, 1);
});

test("with automatic updates off, the automatic check offers the update once, and Update runs the same install", async () => {
  takeUpdateCounts();
  const { updater, seen, updates } = harness({ kind: "appimage" });
  await updater.methods.setAutomaticUpdateDownloads(false);
  assert.equal((await updater.methods.updaterState()).automaticDownloads, false);
  await updater.check(false);
  await updater.check(false);
  assert.deepEqual(seen.offeredInstalls.map((o) => o.version), ["0.2.46"], "offered once");
  assert.deepEqual(updates(), []);
  seen.offeredInstalls[0].run();
  await settled(() => seen.ready.length === 1);
  assert.deepEqual(updates(), ["ArdiaUpdates.download 0.2.46", "ArdiaUpdates.install 0.2.46"]);
  assert.deepEqual(seen.ready.map((r) => r.version), ["0.2.46"]);
  assert.equal(takeUpdateCounts().update_installs_appimage, 1);
});

test("a second window, or a later check, finds the installed update and never installs it again", async () => {
  const disk = new Map();
  const first = harness({ kind: "deb", disk });
  const second = harness({ kind: "deb", disk });
  await first.updater.check(false);
  assert.equal(first.updates().length, 2);
  await first.updater.check(false);
  await second.updater.check(false);
  await second.updater.methods.checkForUpdates();
  assert.equal(first.updates().length, 2, "a later check doesn't download again");
  assert.deepEqual(first.seen.ready.map((r) => r.version), ["0.2.46"], "nor says it again in the same window");
  assert.deepEqual(second.updates(), ["ArdiaUpdates.restart"], "the other window offers Restart, not a new install");
  assert.deepEqual(second.seen.ready.map((r) => r.version), ["0.2.46"]);
  assert.deepEqual((await second.updater.methods.updaterState()).switchCheck, { phase: "ready", channel: "stable", version: "0.2.46" });
});

test("an update under way in another window shows its progress and keeps this window from starting another", async () => {
  const disk = new Map([[UPDATE_PREFERENCES, JSON.stringify({ work: { version: "0.2.46", phase: "downloading", at: 900 } })]]);
  const { updater, updates, seen } = harness({ kind: "deb", disk });
  const state = await updater.methods.updaterState();
  assert.deepEqual(state.switchCheck, { phase: "downloading", channel: "stable", version: "0.2.46" });
  assert.equal(state.sessionInProgress, true);
  await updater.methods.checkForUpdates();
  assert.deepEqual([updates(), seen.requests], [[], 0]);
  const held = [];
  const busy = harness({ kind: "deb", locks: { request: async (name, options, callback) => (held.push([name, options.ifAvailable]), callback(null)) } });
  await busy.updater.methods.checkForUpdates();
  assert.deepEqual(held, [[UPDATE_INSTALL_LOCK, true]]);
  assert.deepEqual([busy.updates(), busy.seen.asked, busy.seen.ready], [[], [], []], "the lock holder does the install");
});

test("an install the package manager owns says to update there, and never opens the release page", async () => {
  const { updater, seen, updates, host } = harness({ kind: "managed" });
  await updater.methods.checkForUpdates();
  await updater.check(false);
  await updater.check(false);
  assert.deepEqual(seen.managed, [["0.2.46", "0.2.45", true], ["0.2.46", "0.2.45", false]]);
  assert.deepEqual([seen.asked, seen.offered, seen.opened, updates()], [[], [], [], []]);
  assert.equal((await updater.methods.updaterState()).automaticDownloads, false);
  assert.equal(installsUpdates(host), false, "Settings hides Automatically update Ardia");
});

test("an install that can't update itself, and an engine without self-update, keep the release page", async () => {
  for (const options of [{ kind: "unsupported noPkexec" }, {}]) {
    const { updater, seen, updates, host } = harness(options);
    await updater.methods.checkForUpdates();
    await updater.check(false);
    assert.deepEqual(seen.asked, [["0.2.46", "0.2.45"]]);
    assert.deepEqual(seen.opened, [page("v0.2.46")]);
    assert.deepEqual(seen.offered, ["0.2.46"]);
    assert.deepEqual([seen.ready, seen.managed, updates()], [[], [], []]);
    assert.equal((await updater.methods.updaterState()).automaticDownloads, false);
    assert.equal(installsUpdates(host), false);
    if (!options.kind) assert.ok(!seen.calls.includes("ArdiaUpdates.installKind"), "an old engine is never asked how it was installed");
  }
});

test("a failed download or install falls back to the release page and counts why", async () => {
  takeUpdateCounts();
  const offline = harness({ kind: "deb", download: () => ({ ok: false, reason: "network" }) });
  await offline.updater.methods.checkForUpdates();
  await settled(() => offline.seen.opened.length === 1);
  assert.deepEqual(offline.seen.asked, [["0.2.46", "0.2.45", "failed"]]);
  assert.deepEqual(offline.seen.opened, [page("v0.2.46")]);
  assert.deepEqual(offline.updates(), ["ArdiaUpdates.download 0.2.46"]);
  assert.deepEqual((await offline.updater.methods.updaterState()).switchCheck, { phase: "found", channel: "stable", version: "0.2.46" });
  assert.equal(JSON.parse(offline.docs.get(UPDATE_PREFERENCES)).work, null, "a failed download leaves no update under way");
  const refused = harness({ kind: "tarball", install: () => ({ ok: false, reason: "polkit" }) });
  await refused.updater.check(false);
  await refused.updater.check(false);
  assert.deepEqual(refused.seen.offered, ["0.2.46 failed"], "an automatic failure offers the page once");
  assert.equal(refused.updates().length, 2, "and doesn't retry the same release");
  assert.deepEqual(refused.seen.ready, []);
  const odd = harness({ kind: "appimage", install: () => { throw new Error("gone"); } });
  await odd.updater.methods.checkForUpdates();
  await settled(() => odd.seen.asked.length === 1);
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), {
    update_downloads_started: 3,
    update_downloads_finished: 2,
    update_download_failures_network: 1,
    update_install_failures_polkit: 1,
    update_install_failures_other: 1,
  });
});

test("self-update counts nothing while sharing is off", async () => {
  takeUpdateCounts();
  setConsentPeriod(false, null);
  try {
    const { updater, seen, updates } = harness({ kind: "deb" });
    await updater.check(false);
    seen.ready[0].restart();
    await settled(() => updates().includes("ArdiaUpdates.restart"));
    const failing = harness({ kind: "deb", download: () => ({ ok: false, reason: "disk" }) });
    await failing.updater.check(false);
  } finally {
    setConsentPeriod(true, "host-updates-test");
  }
  assert.deepEqual(SELF_UPDATE_COUNTS(takeUpdateCounts()), {});
});
