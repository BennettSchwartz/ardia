#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchVariables, session, sleep } from "../../../scripts/lib/instance.mjs";

const usage = `usage: cli-token-kinds-check.mjs <Ardia.app>
Checks the two kinds of token connection in one hidden instance with two windows, over the real token server (no
DevTools port). It needs a test build: it launches with the test flags privatePasteboard and pluginInputHold and aborts
before its first step unless the engine reports both. A Developer ID build ignores test flags, so there it stops at
that gate (the expected result on a signed build). pluginInputHold holds a plugin's mouse deliveries for 2 s and its
out-of-scope detaches for 5 s, so a delivery admitted before its tab leaves lands after the tab is back, every run.
The ardia command's token (kind cli) gets every method and target, including Browser.setDownloadBehavior, a chrome://
page and the browser target. A plugin credential minted for window 1 (engine.cliPluginCredential, kind plugin) sees and
attaches only window 1's web pages, is refused a chrome:// attach, Browser.setDownloadBehavior, DOM.setFileInputFiles,
cookies, Target.createTarget and window 2's page, isn't written to ArdiaControl.json and can't read /ardia/active;
revoking it closes its socket and a new connection with it is refused. A plugin gets exactly its allowlist: the
plain-data DOM and accessibility reads work, DOM.focus and DOM.scrollIntoViewIfNeeded work on its own nodes, and every
Runtime method, DOM.resolveNode, DOM search, Page.createIsolatedWorld and any Runtime object or context id are refused,
as are Page.navigate's referrer, referrerPolicy, transitionType and frameId, every scheme but http, https and
about:blank, and a script on reload; no Network, console or Runtime event reaches it; a frame of another tab is out of
its reach; it accepts and cancels a dialog; keys and insertText type; a press, move and release over a draggable
element starts no drag (no dragenter, dragover or drop). When its tab moves to another window (or out and straight
back), a command in flight answers tab_out_of_scope, a late reply never arrives, the session is detached, mouse and
wheel input it queued before the move never lands even though the tab is back, and a fresh attach to the returned tab
takes input again. Backend node ids from another tab in the same renderer and node ids of a node the page adopted
into a window-2 document are refused for reads, focus and scroll; paste and native key codes, editing commands
without a key, the middle button (both encodings), window screenshots and clips outside the viewport are refused or
confined, a target whose opener left the window shows no opener, select all then deleteBackward clears a field, and
macOS word deletion still works; a scope close drains its replies even with a backlog and a concurrent command, and a
revoke during it closes at once. The CLI answers a page's showOpenFilePicker, showSaveFilePicker and
showDirectoryPicker with Ardia.answerFilePicker (no dialog opens), and a plugin is refused that command. The app's
file eval runs through its perf probe, so a release build works.`;
const [appArg] = process.argv.slice(2);
if (!appArg || appArg === "-h" || appArg === "--help") {
  console.log(usage);
  process.exit(appArg ? 0 : 64);
}
const app = resolve(appArg);
if (app.startsWith("/Applications/")) throw new Error("never an installed app");

const work = mkdtempSync(join(tmpdir(), "ac-token-kinds-"));
const data = join(work, "d");
mkdirSync(data);

const PICKERS = `<textarea id=area style="position:fixed;left:240px;top:40px;width:200px;height:60px"></textarea>
<button id=open style="position:fixed;left:0;top:40px;width:200px;height:40px">open</button>
<button id=save style="position:fixed;left:0;top:90px;width:200px;height:40px">save</button>
<button id=dir style="position:fixed;left:0;top:140px;width:200px;height:40px">dir</button>
<div id=drag draggable=true style="position:fixed;left:240px;top:120px;width:80px;height:30px;background:#ccc">drag</div>
<div id=drop style="position:fixed;left:240px;top:170px;width:80px;height:30px;background:#eee">drop</div>
<script>
window.dragLog = [];
for (const type of ["dragstart", "dragend"]) drag.addEventListener(type, () => dragLog.push(type));
for (const type of ["dragenter", "dragover", "drop"]) drop.addEventListener(type, (e) => { e.preventDefault(); dragLog.push(type); });
const report = (p) => p.then((v) => (window.picked = v), (e) => (window.picked = "error:" + e.name));
open.onclick = () => report(showOpenFilePicker().then(async ([h]) => "open:" + h.name + ":" + (await (await h.getFile()).text())));
save.onclick = () => report(showSaveFilePicker().then(async (h) => { const w = await h.createWritable(); await w.write("saved by the page"); await w.close(); return "save:" + h.name; }));
dir.onclick = () => report(showDirectoryPicker().then(async (d) => { window.dirHandle = d; const names = []; for await (const [n] of d.entries()) names.push(n); return "dir:" + names.sort().join(","); }));
</script>`;
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  const answer = () => res.end(`<!doctype html><title>${req.url.slice(1)}</title><input type=file id=f>${PICKERS}`);
  if (req.url.startsWith("/slow")) setTimeout(answer, 3000);
  else answer();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

writeFileSync(join(data, "session.json"), JSON.stringify(session({
  settings: { cliControl: true },
  windows: [{ id: "w1" }, { id: "w2" }],
  tabs: [{ id: "t1", windowId: "w1", url: `${origin}/one` }, { id: "t3", windowId: "w1", url: `${origin}/three` }, { id: "t2", windowId: "w2", url: `${origin}/two` }],
})));
writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));
writeFileSync(join(data, "perf-probe"), "");

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const until = async (what, fn, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const v = await fn().catch(() => null);
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};
let evals = 0;
const appEval = async (body) => {
  const id = `k${process.pid}-${++evals}`;
  writeFileSync(join(data, "dev-eval.js"), `// ${id}\n${body}`);
  return until(`eval ${id}`, async () => {
    const out = JSON.parse(readFileSync(join(data, "dev-eval-result.json"), "utf8"));
    if (out.id !== id) return null;
    writeFileSync(join(data, "dev-eval-result.json"), JSON.stringify({ id }));
    if (out.error) throw new Error(out.error);
    return { value: out.result };
  }).then((r) => r.value);
};

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let next = 1;
    const waiting = new Map();
    const events = [];
    const replies = [];
    ws.onopen = () => resolve({
      ws, events, replies,
      closed: new Promise((r) => ws.addEventListener("close", r)),
      raw: (id, method, params = {}, sessionId) => ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })),
      repliesTo: async (id, since, ms) => {
        await sleep(ms);
        return replies.slice(since).filter((m) => m.id === id);
      },
      send: (method, params = {}, sessionId) => new Promise((done) => {
        const id = 1000000 + next++;
        waiting.set(id, done);
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => waiting.delete(id) && done({ error: { message: "timed out" } }), 15000);
      }),
    });
    ws.onerror = () => reject(new Error("websocket refused"));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined) replies.push(m);
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else if (m.id === undefined) events.push(m);
    };
  });
}
const refused = (reply) => !!reply.error;
const text = (reply) => (reply.error ? reply.error.message : JSON.stringify(reply.result).slice(0, 120));

const testEnv = Object.entries(launchVariables({ test: { privatePasteboard: true, pluginInputHold: true } })).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
execFileSync("open", ["-g", "-n", "--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${data}`, ...testEnv, app]);
const controlFile = join(data, "Chromium", "ArdiaControl.json");
let pid = null;
try {
  await until("ArdiaControl.json", async () => existsSync(controlFile) && statSync(controlFile).size > 0, 90000);
  const control = JSON.parse(readFileSync(controlFile, "utf8"));
  pid = control.pid;
  const engineStatus = await appEval(`return ac.engine.call("engine.cliControlStatus")`).catch(() => null);
  if (engineStatus?.privatePasteboard !== true || engineStatus?.pluginInputHold !== true) {
    console.log("ABORT  the engine didn't confirm its test flags (privatePasteboard, pluginInputHold), so no step ran: this needs a test build, and the general pasteboard is never used");
    throw new Error("test flags not confirmed");
  }
  check("the engine confirms its private pasteboard and plugin input hold before any step", true);
  const base = `ws://127.0.0.1:${control.port}${control.browser}`;

  const cli = await connect(`${base}?token=${control.token}`);
  const urlsOf = async (c) => ((await c.send("Target.getTargets")).result?.targetInfos ?? []).filter((t) => t.type === "page").map((t) => t);
  const pages = await until("both windows' pages", async () => {
    const all = await urlsOf(cli);
    const one = all.find((t) => t.url === `${origin}/one`), two = all.find((t) => t.url === `${origin}/two`);
    return one && two ? { one, two } : null;
  });
  const chrome = await cli.send("Target.createTarget", { url: "chrome://version", background: true });
  const chromeSession = chrome.result && (await cli.send("Target.attachToTarget", { targetId: chrome.result.targetId, flatten: true }));
  check("cli: a chrome:// page attaches", !!chromeSession?.result?.sessionId, text(chromeSession ?? chrome));
  const cliDownloads = await cli.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") });
  check("cli: Browser.setDownloadBehavior answers", !refused(cliDownloads), text(cliDownloads));
  const cliBrowser = await cli.send("Target.attachToBrowserTarget");
  check("cli: the browser target attaches", !!cliBrowser.result?.sessionId, text(cliBrowser));
  const cliTwo = await cli.send("Target.attachToTarget", { targetId: pages.two.targetId, flatten: true });
  check("cli: a page in either window attaches", !!cliTwo.result?.sessionId, text(cliTwo));

  const minted = await appEval(`return ac.engine.call("engine.cliPluginCredential", { tabId: "t1" })`);
  check("a plugin credential is minted for window 1", !!minted?.credential && !!minted?.id, JSON.stringify(minted ?? null).replace(/"credential":"[^"]+"/, '"credential":"…"'));
  check("the plugin credential isn't in ArdiaControl.json", !readFileSync(controlFile, "utf8").includes(minted.credential));
  const active = await fetch(`http://127.0.0.1:${control.port}/ardia/active?token=${encodeURIComponent(minted.credential)}`).then((r) => r.status, () => 0);
  check("the plugin credential can't read /ardia/active", active !== 200, String(active));

  const plugin = await connect(`${base}?token=${encodeURIComponent(minted.credential)}`);
  const seen = (await urlsOf(plugin)).map((t) => t.url);
  check("plugin: Target.getTargets is filtered to window 1's web pages", seen.includes(`${origin}/one`) && !seen.includes(`${origin}/two`) && seen.every((u) => u.startsWith(origin)), seen.join(" "));
  const own = await plugin.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true });
  const ps = own.result?.sessionId;
  check("plugin: window 1's page attaches", !!ps, text(own));
  const other = await plugin.send("Target.attachToTarget", { targetId: pages.two.targetId, flatten: true });
  check("plugin: window 2's page is refused", refused(other), text(other));
  const chromeAttach = await plugin.send("Target.attachToTarget", { targetId: chrome.result.targetId, flatten: true });
  check("plugin: a chrome:// attach is refused", refused(chromeAttach), text(chromeAttach));

  await plugin.send("Page.enable", {}, ps);
  const frameId = (await plugin.send("Page.getFrameTree", {}, ps)).result?.frameTree?.frame?.id;
  for (const [method, params] of [["Runtime.enable", {}], ["Runtime.evaluate", { expression: "1" }], ["Runtime.callFunctionOn", { functionDeclaration: "() => 1", executionContextId: 1 }], ["Runtime.getProperties", { objectId: "1.1.1" }], ["Runtime.releaseObject", { objectId: "1.1.1" }], ["Runtime.releaseObjectGroup", { objectGroup: "x" }], ["Runtime.addBinding", { name: "x" }], ["Page.createIsolatedWorld", { frameId }]]) {
    const reply = await plugin.send(method, params, ps);
    check(`plugin: ${method} is refused`, refused(reply) && /plugin/.test(reply.error?.message ?? ""), text(reply));
  }
  const pluginRoot = async () => (await plugin.send("DOM.getDocument", { depth: -1 }, ps)).result?.root?.nodeId;
  const pluginNode = async (selector) => (await plugin.send("DOM.querySelector", { nodeId: await pluginRoot(), selector }, ps)).result?.nodeId;
  const rootNode = await pluginRoot();
  const nodeIn = async (selector) => (await plugin.send("DOM.querySelector", { nodeId: rootNode, selector }, ps)).result?.nodeId;
  const areaNode = await nodeIn("#area");
  const openNode = await nodeIn("#open");
  const reads = [
    ["DOM.querySelectorAll", { nodeId: rootNode, selector: "button" }, (r) => r.nodeIds?.length === 3],
    ["DOM.getAttributes", { nodeId: openNode }, (r) => r.attributes?.includes("open")],
    ["DOM.getOuterHTML", { nodeId: openNode }, (r) => r.outerHTML?.startsWith("<button")],
    ["DOM.getBoxModel", { nodeId: openNode }, (r) => !!r.model],
    ["DOM.getContentQuads", { nodeId: openNode }, (r) => r.quads?.length > 0],
    ["DOM.describeNode", { nodeId: openNode }, (r) => r.node?.nodeName === "BUTTON"],
    ["DOM.getNodeForLocation", { x: 100, y: 60 }, (r) => !!r.backendNodeId],
    ["Accessibility.getPartialAXTree", { nodeId: openNode }, (r) => r.nodes?.length > 0],
    ["Accessibility.queryAXTree", { nodeId: rootNode, role: "button" }, (r) => r.nodes?.length === 3],
  ];
  for (const [method, params, good] of reads) {
    const reply = await plugin.send(method, params, ps);
    check(`plugin: ${method} answers with plain data`, !refused(reply) && good(reply.result ?? {}), text(reply));
  }
  const objectHandle = await plugin.send("DOM.describeNode", { objectId: "1.1.1" }, ps);
  check("plugin: a Runtime object id is refused on a DOM read", refused(objectHandle) && /objectId/.test(objectHandle.error?.message ?? ""), text(objectHandle));
  const focused = await plugin.send("DOM.focus", { nodeId: areaNode }, ps);
  const scrolled = await plugin.send("DOM.scrollIntoViewIfNeeded", { nodeId: openNode }, ps);
  check("plugin: DOM.focus and DOM.scrollIntoViewIfNeeded work on its own node", !refused(focused) && !refused(scrolled), `${text(focused)} ${text(scrolled)}`);
  const wheel = await plugin.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 100, y: 60, deltaX: 0, deltaY: 50 }, ps);
  check("plugin: a mouseWheel event answers", !refused(wheel), text(wheel));
  const dragSteps = [["mousePressed", 280, 135, 1], ["mouseMoved", 280, 145, 1], ["mouseMoved", 280, 165, 1], ["mouseMoved", 280, 185, 1], ["mouseReleased", 280, 185, 0]];
  const dragReplies = [];
  for (const [type, x, y, buttons] of dragSteps) dragReplies.push(await plugin.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 }, ps));
  await sleep(500);

  const allowed = [
    ["DOM.getDocument", {}],
    ["Accessibility.getFullAXTree", {}],
    ["Page.getLayoutMetrics", {}],
    ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }],
    ["Emulation.setFocusEmulationEnabled", { enabled: true }],
    ["Target.getTargetInfo", { targetId: pages.one.targetId }],
  ];
  for (const [method, params] of allowed) {
    const reply = await plugin.send(method, params, method.startsWith("Target.") ? undefined : ps);
    check(`plugin: ${method} answers`, !refused(reply), text(reply));
  }
  const refusedHere = [
    ["DOM.setFileInputFiles", { files: [join(work, "x")], backendNodeId: 1 }, ps],
    ["DOM.resolveNode", { backendNodeId: 1 }, ps],
    ["DOM.performSearch", { query: "button" }, ps],
    ["DOM.getSearchResults", { searchId: "1", fromIndex: 0, toIndex: 1 }, ps],
    ["DOM.discardSearchResults", { searchId: "1" }, ps],
    ["Input.setInterceptDrags", { enabled: true }, ps],
    ["Page.printToPDF", {}, ps],
    ["Page.addScriptToEvaluateOnNewDocument", { source: "1" }, ps],
    ["Page.startScreencast", {}, ps],
    ["Page.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") }, ps],
    ["Input.dispatchDragEvent", { type: "dragEnter", x: 1, y: 1, data: { items: [], dragOperationsMask: 1 } }, ps],
    ["Emulation.setDeviceMetricsOverride", { width: 1, height: 1, deviceScaleFactor: 1, mobile: false }, ps],
    ["Target.createTarget", { url: `${origin}/three` }],
    ["Target.setDiscoverTargets", { discover: true }],
    ["Target.activateTarget", { targetId: pages.one.targetId }],
    ["Target.closeTarget", { targetId: pages.one.targetId }],
    ["Target.attachToBrowserTarget", {}],
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
    ["Network.enable", {}, ps],
    ["Network.getCookies", {}, ps],
    ["Network.enableDeviceBoundSessions", { enable: true }, ps],
    ["Network.deleteDeviceBoundSession", { key: { site: origin, id: "x" } }, ps],
    ["Fetch.enable", {}, ps],
    ["Storage.getCookies", {}],
    ["IO.read", { handle: "1" }],
    ["Tracing.start", {}],
    ["Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "dl") }],
    ["Overlay.highlightNode", { highlightConfig: {}, backendNodeId: 1 }, ps],
    ["Ardia.answerFilePicker", { kind: "open", paths: ["/etc/hosts"] }, ps],
  ];
  for (const [method, params, sessionId] of refusedHere) {
    const reply = await plugin.send(method, params, sessionId);
    check(`plugin: ${method} is refused`, refused(reply) && /plugin/.test(reply.error?.message ?? ""), text(reply));
  }

  await cli.send("Runtime.evaluate", { expression: "console.log('main world'); location.reload()" }, cliTwo.result?.sessionId);
  const csOne = (await cli.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true })).result?.sessionId;
  await cli.send("Network.enable", {}, csOne);
  await cli.send("Runtime.evaluate", { expression: "console.log('main world'); fetch(location.href)" }, csOne);
  await sleep(1500);
  const leaked = plugin.events.filter((e) => e.method?.startsWith("Network.") || e.method === "Runtime.consoleAPICalled");
  check("plugin: no Network or console event reaches it", leaked.length === 0, leaked.map((e) => e.method).join(" "));
  const dragLog = (await cli.send("Runtime.evaluate", { expression: "window.dragLog.join(',')", returnByValue: true }, csOne)).result?.result?.value ?? "";
  check("plugin: a press, move and release over a draggable element starts no drag (no dragenter, dragover or drop)", typeof dragLog === "string" && !/dragenter|dragover|drop(,|$)/.test(dragLog) && dragReplies.every((r) => !r.error || /Not allowed/.test(r.error.message)), `${dragLog || "no drag events"}; ${dragReplies.map(text).join(" | ")}`);
  const runtimeEvents = plugin.events.filter((e) => e.method?.startsWith("Runtime."));
  check("plugin: no Runtime event reaches it", runtimeEvents.length === 0, runtimeEvents.map((e) => e.method).join(" "));
  const activeIs = async (id) => (await cli.send("Runtime.evaluate", { expression: `document.activeElement?.id === ${JSON.stringify(id)}`, returnByValue: true }, csOne)).result?.result?.value === true;
  await plugin.send("DOM.focus", { nodeId: await pluginNode("#area") }, ps);
  check("plugin: DOM.focus moves focus to its node", await activeIs("area"));

  const key = (extra) => plugin.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, ...extra }, ps);
  const selectAll = await key({ commands: ["selectAll"] });
  check("plugin: Input.dispatchKeyEvent with selectAll answers", !refused(selectAll), text(selectAll));
  const paste = await key({ commands: ["paste"] });
  check("plugin: Input.dispatchKeyEvent with paste is refused", refused(paste) && /plugin/.test(paste.error?.message ?? ""), text(paste));
  const nativeKey = await key({ nativeVirtualKeyCode: 0 });
  check("plugin: Input.dispatchKeyEvent with nativeVirtualKeyCode is refused", refused(nativeKey) && /plugin/.test(nativeKey.error?.message ?? ""), text(nativeKey));
  await cli.send("Emulation.setFocusEmulationEnabled", { enabled: true }, csOne);
  const cliValue = async (expression) => (await cli.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, csOne)).result?.result?.value;
  const cliKey = async (key, code, keyCode, modifiers, commands) => {
    await cli.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(commands ? { commands } : {}) }, csOne);
    await cli.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers }, csOne);
  };
  const probe = `ardia-clipboard-probe-${process.pid}`;
  const fillArea = (value, select) => cliValue(`(() => { const a = document.getElementById("area"); a.value = ${JSON.stringify(value)}; a.focus(); ${select ? "a.select();" : "a.setSelectionRange(a.value.length, a.value.length);"} return true })()`);
  const areaValue = () => cliValue(`document.getElementById("area").value`);
  await fillArea(probe, true);
  await cliKey("c", "KeyC", 67, 4, ["copy"]);
  await fillArea("", false);
  await cliKey("v", "KeyV", 86, 4, ["paste"]);
  await sleep(300);
  const roundTrip = await areaValue();
  check("cli: the private pasteboard round-trips (the CLI copies and pastes in a page)", roundTrip === probe, JSON.stringify(roundTrip));
  const clipboardKeys = [...readFileSync(new URL("../../../engine/chromium/src/chrome/browser/ardia/ac_cli_plugin_clipboard_keys.h", import.meta.url), "utf8").matchAll(/\{(\d+), (\d+), "([A-Za-z]*)"\}/g)]
    .map(([, keyCode, modifiers, domKey]) => ({ keyCode: Number(keyCode), modifiers: Number(modifiers), domKey }));
  const pluginFocus = async () => plugin.send("DOM.focus", { nodeId: await pluginNode("#area") }, ps);
  const pluginKey = async (fields) => {
    const down = await plugin.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...fields }, ps);
    await plugin.send("Input.dispatchKeyEvent", { type: "keyUp", ...fields, commands: undefined }, ps);
    return down;
  };
  for (const entry of clipboardKeys) {
    await fillArea("plugin-selected-text", true);
    await pluginFocus();
    const reply = await pluginKey({ modifiers: entry.modifiers, ...(entry.domKey ? { key: entry.domKey } : { windowsVirtualKeyCode: entry.keyCode }) });
    await sleep(250);
    const after = await areaValue();
    check(`plugin: clipboard key ${entry.domKey || entry.keyCode} with modifiers ${entry.modifiers} is refused and pastes nothing`, refused(reply) && !String(after).includes(probe), `${text(reply)} area=${JSON.stringify(after)}`);
  }
  await fillArea("", false);
  await pluginFocus();
  await pluginKey({ key: "v", code: "KeyV", windowsVirtualKeyCode: 86, modifiers: 4 });
  await sleep(300);
  const cmdV = await areaValue();
  check("plugin: Cmd+V pastes nothing", !String(cmdV).includes(probe), JSON.stringify(cmdV));
  await fillArea("", false);
  await cliKey("v", "KeyV", 86, 4, ["paste"]);
  await sleep(300);
  const stillProbe = await areaValue();
  check("plugin: its copy and cut attempts left the pasteboard as the CLI set it", stillProbe === probe, JSON.stringify(stillProbe));
  await fillArea("select me", false);
  await pluginFocus();
  const cmdA = await pluginKey({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] });
  const selection = await cliValue(`(() => { const a = document.getElementById("area"); return a.selectionStart + ":" + a.selectionEnd })()`);
  check("plugin: Cmd+A selects all", !refused(cmdA) && selection === "0:9", `${text(cmdA)} ${selection}`);
  await fillArea("", false);
  await pluginFocus();
  for (const character of "hey") {
    await plugin.send("Input.dispatchKeyEvent", { type: "keyDown", key: character, text: character, windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0) }, ps);
    await plugin.send("Input.dispatchKeyEvent", { type: "keyUp", key: character, windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0) }, ps);
  }
  const typed = await areaValue();
  check("plugin: plain typing still types", typed === "hey", JSON.stringify(typed));
  await pluginFocus();
  await pluginKey({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: process.platform === "darwin" ? 4 : 2, commands: ["selectAll"] });
  const cleared = await pluginKey({ key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, commands: ["deleteBackward"] });
  const afterClear = await areaValue();
  check("plugin: select all then deleteBackward clears a field", !refused(cleared) && afterClear === "", `${text(cleared)} ${JSON.stringify(afterClear)}`);
  await pluginFocus();
  const inserted = await plugin.send("Input.insertText", { text: "zz" }, ps);
  const afterInsert = await areaValue();
  check("plugin: Input.insertText types into the focused field", !refused(inserted) && afterInsert === "zz", `${text(inserted)} ${JSON.stringify(afterInsert)}`);
  for (const accept of [true, false]) {
    const mark = cli.replies.length;
    cli.raw(555000 + Number(accept), "Runtime.evaluate", { expression: "confirm('ardia dialog')", returnByValue: true }, csOne);
    const opened = await until("the dialog", async () => plugin.events.find((e) => e.method === "Page.javascriptDialogOpening" && e.sessionId === ps && !e.handled) ?? null, 8000).catch(() => null);
    if (opened) opened.handled = true;
    const handled = await plugin.send("Page.handleJavaScriptDialog", { accept }, ps);
    const answer = (await cli.repliesTo(555000 + Number(accept), mark, 1500))[0]?.result?.result?.value;
    check(`plugin: Page.handleJavaScriptDialog ${accept ? "accepts" : "cancels"} a dialog`, !!opened && !refused(handled) && answer === accept, `${text(handled)} answer=${answer}`);
  }
  if (process.platform === "darwin") {
    await fillArea("hello world", false);
    await pluginFocus();
    const wordDelete = await pluginKey({ key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: 1 });
    const afterWordDelete = await areaValue();
    check("plugin: macOS word deletion (Alt+Backspace) is allowed and deletes a word", !refused(wordDelete) && afterWordDelete === "hello ", `${text(wordDelete)} ${JSON.stringify(afterWordDelete)}`);
  }
  for (const commands of [["paste"], ["copy"]]) {
    const keyless = await plugin.send("Input.dispatchKeyEvent", { type: "rawKeyDown", commands }, ps);
    check(`plugin: editing command ${commands[0]} without a key is refused`, refused(keyless) && /plugin/.test(keyless.error?.message ?? ""), text(keyless));
  }
  for (const [name, params] of [["button middle", { type: "mousePressed", x: 5, y: 5, button: "middle", clickCount: 1 }], ["buttons with the middle bit", { type: "mouseMoved", x: 5, y: 5, buttons: 4 }]]) {
    const middle = await plugin.send("Input.dispatchMouseEvent", params, ps);
    check(`plugin: the middle button (${name}) is refused`, refused(middle) && /plugin/.test(middle.error?.message ?? ""), text(middle));
  }
  const reloadScript = await plugin.send("Page.reload", { scriptToEvaluateOnLoad: "window.ardiaReloadMarker = 1" }, ps);
  await sleep(500);
  const marker = await cli.send("Runtime.evaluate", { expression: "typeof window.ardiaReloadMarker", returnByValue: true }, csOne);
  check("plugin: Page.reload with a script to run on load is refused and the marker never runs", refused(reloadScript) && /plugin/.test(reloadScript.error?.message ?? "") && marker.result?.result?.value === "undefined", `${text(reloadScript)} marker=${text(marker)}`);

  const shot = await plugin.send("Page.captureScreenshot", { fromSurface: false }, ps);
  check("plugin: Page.captureScreenshot answers from the page surface even when asked for the window", !refused(shot) && !!shot.result?.data, text(shot));
  const clipped = await plugin.send("Page.captureScreenshot", { clip: { x: 0, y: 0, width: 100000, height: 100, scale: 1 } }, ps);
  check("plugin: Page.captureScreenshot with a clip outside the viewport is refused", refused(clipped) && /plugin/.test(clipped.error?.message ?? ""), text(clipped));

  for (const [name, params] of [["referrer", { referrer: origin }], ["referrerPolicy", { referrerPolicy: "unsafeUrl" }], ["transitionType", { transitionType: "typed" }], ["frameId", { frameId }]]) {
    const navigated = await plugin.send("Page.navigate", { url: `${origin}/one`, ...params }, ps);
    check(`plugin: Page.navigate with ${name} is refused`, refused(navigated) && /plugin/.test(navigated.error?.message ?? ""), text(navigated));
  }
  const tree = await plugin.send("Accessibility.getFullAXTree", {}, ps);
  const button = tree.result?.nodes?.find((n) => n.role?.value === "button" && n.backendDOMNodeId);
  const described = await plugin.send("DOM.describeNode", { backendNodeId: button?.backendDOMNodeId }, ps);
  const focusedByBackend = await plugin.send("DOM.focus", { backendNodeId: button?.backendDOMNodeId }, ps);
  const resolved = await plugin.send("DOM.resolveNode", { backendNodeId: button?.backendDOMNodeId }, ps);
  check("plugin: a backendNodeId from its own tab's accessibility tree describes and focuses, and DOM.resolveNode is refused", !!button && !refused(described) && !refused(focusedByBackend) && refused(resolved), `${text(described)} ${text(focusedByBackend)} ${text(resolved)}`);
  await cli.send("Runtime.evaluate", { expression: `window.open(${JSON.stringify(`${origin}/four`)})`, userGesture: true }, csOne);
  const popup = await until("the popup", async () => (await urlsOf(cli)).find((t) => t.url === `${origin}/four`) ?? null, 15000).catch(() => null);
  const movedPopup = await appEval(`const t = Object.values(ac.store.getState().tabs).find((x) => x?.url?.endsWith("/four")); if (t) ac.actions.moveTabToWindow(t.id, "w2"); return !!t`);
  await sleep(1000);
  const popupSession = popup && (await cli.send("Target.attachToTarget", { targetId: popup.targetId, flatten: true })).result?.sessionId;
  const popupDocument = popupSession && (await cli.send("DOM.getDocument", { depth: 2 }, popupSession));
  const html = popupDocument?.result?.root?.children?.find((c) => c.nodeName === "HTML");
  const foreign = html?.children?.find((c) => c.nodeName === "BODY")?.backendNodeId ?? html?.backendNodeId;
  const crossTab = await plugin.send("DOM.describeNode", { backendNodeId: foreign }, ps);
  check("plugin: a backendNodeId from another tab in the same renderer is refused", !!popup && movedPopup === true && !!foreign && refused(crossTab) && /isn't in this page/.test(crossTab.error?.message ?? ""), text(crossTab));
  for (const method of ["DOM.focus", "DOM.scrollIntoViewIfNeeded"]) {
    const crossTabAct = await plugin.send(method, { backendNodeId: foreign }, ps);
    check(`plugin: ${method} on another tab's node is refused`, !!foreign && refused(crossTabAct) && /isn't in this page/.test(crossTabAct.error?.message ?? ""), text(crossTabAct));
  }
  const popupFrameId = popupSession && (await cli.send("Page.getFrameTree", {}, popupSession)).result?.frameTree?.frame?.id;
  const foreignAx = await plugin.send("Accessibility.getFullAXTree", { frameId: popupFrameId }, ps);
  const ownFrames = JSON.stringify((await plugin.send("Page.getFrameTree", {}, ps)).result ?? {});
  const ownTree = JSON.stringify((await plugin.send("DOM.getDocument", { depth: -1, pierce: true }, ps)).result ?? {});
  check("plugin: frame traversal stays in its own page (another tab's frame is refused and never listed)", !!popupFrameId && refused(foreignAx) && !ownFrames.includes(popupFrameId) && !ownTree.includes(popupFrameId), `${text(foreignAx)}`);
  await cli.send("Runtime.evaluate", { expression: "(() => { const p = document.createElement('p'); p.id = 'adoptme'; p.textContent = 'adopt me'; document.body.append(p); return true })()" }, csOne);
  const adoptRoot = await pluginRoot();
  const adoptNode = (await plugin.send("DOM.querySelector", { nodeId: adoptRoot, selector: "#adoptme" }, ps)).result?.nodeId;
  const adopted = (await cli.send("Runtime.evaluate", { expression: "(() => { const n = window.opener?.document.getElementById('adoptme'); if (!n) return false; document.body.append(document.adoptNode(n)); return true })()", returnByValue: true }, popupSession)).result?.result?.value;
  const adoptedReads = [];
  for (const [method, params] of [["DOM.getAttributes", { nodeId: adoptNode }], ["DOM.getOuterHTML", { nodeId: adoptNode }], ["DOM.getBoxModel", { nodeId: adoptNode }], ["DOM.describeNode", { nodeId: adoptNode }], ["DOM.focus", { nodeId: adoptNode }], ["DOM.scrollIntoViewIfNeeded", { nodeId: adoptNode }], ["Accessibility.getPartialAXTree", { nodeId: adoptNode }], ["Accessibility.queryAXTree", { nodeId: adoptNode }]]) {
    adoptedReads.push([method, await plugin.send(method, params, ps)]);
  }
  check("plugin: a node the page adopted into a window-2 document is refused by nodeId for every read, focus and scroll", !!adoptNode && adopted === true && adoptedReads.every(([, r]) => refused(r)), adoptedReads.map(([m, r]) => `${m}: ${text(r)}`).join(" | "));

  const folder = join(work, "picked");
  mkdirSync(folder);
  writeFileSync(join(folder, "a.txt"), "from the ardia command");
  writeFileSync(join(folder, "b.txt"), "b");
  const cs = (await cli.send("Target.attachToTarget", { targetId: pages.one.targetId, flatten: true })).result?.sessionId;
  const click = async (id) => {
    await cli.send("Runtime.evaluate", { expression: "window.picked = null" }, cs);
    const box = (await cli.send("Runtime.evaluate", { expression: `(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`, returnByValue: true }, cs)).result?.result?.value ?? [0, 0];
    for (const type of ["mousePressed", "mouseReleased"]) await cli.send("Input.dispatchMouseEvent", { type, x: box[0], y: box[1], button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, cs);
    return until(`the ${id} picker`, async () => (await cli.send("Runtime.evaluate", { expression: "window.picked", returnByValue: true }, cs)).result?.result?.value ?? null, 15000).catch((e) => String(e.message));
  };
  const arm = (kind, paths) => cli.send("Ardia.answerFilePicker", { kind, paths }, cs);
  const armedOpen = await arm("open", [join(folder, "a.txt")]);
  check("cli: Ardia.answerFilePicker arms an answer", !refused(armedOpen), text(armedOpen));
  check("cli: showOpenFilePicker takes the answered file", (await click("open")) === "open:a.txt:from the ardia command");
  await arm("save", [join(folder, "out.txt")]);
  const saved = await click("save");
  check("cli: showSaveFilePicker takes the answered path and the page writes it", saved === "save:out.txt" && existsSync(join(folder, "out.txt")) && readFileSync(join(folder, "out.txt"), "utf8") === "saved by the page", saved);
  await arm("directory", [folder]);
  const listed = await click("dir");
  check("cli: showDirectoryPicker takes the answered folder without a permission prompt", listed === "dir:a.txt,b.txt,out.txt", listed);
  const readwrite = await cli.send("Runtime.evaluate", { expression: "Promise.race([window.dirHandle.queryPermission({ mode: 'read' }).then((read) => window.dirHandle.queryPermission({ mode: 'readwrite' }).then((write) => read + '/' + write))])", awaitPromise: true, returnByValue: true }, cs);
  check("cli: a read-only directory answer leaves the folder granted for reading and not for writing", !refused(readwrite) && !readwrite.result?.exceptionDetails && readwrite.result?.result?.value === "granted/prompt", text(readwrite));
  await arm("open", []);
  check("cli: an empty answer cancels the picker", (await click("open")) === "error:AbortError");
  const wrongKind = await arm("save", [join(folder, "x.txt")]);
  const unanswered = await click("open").then((v) => v, () => null);
  check("cli: an answer of another kind leaves the picker alone", !refused(wrongKind) && unanswered !== "open:x.txt", String(unanswered));

  await arm("open", [join(folder, "a.txt")]);
  await cli.send("Page.reload", {}, cs);
  await until("page one reloaded", async () => (await cli.send("Runtime.evaluate", { expression: "document.readyState === 'complete' && !!document.getElementById('open')", returnByValue: true }, cs)).result?.result?.value);
  const afterNavigation = await click("open").then((v) => v, () => null);
  check("cli: an answer armed before a navigation isn't used by the new document", afterNavigation !== "open:a.txt:from the ardia command", String(afterNavigation));
  const duplicateMark = cli.replies.length;
  cli.raw(424242, "Runtime.evaluate", { expression: "new Promise((r) => setTimeout(() => r(1), 1500))", awaitPromise: true }, cs);
  cli.raw(424242, "Ardia.answerFilePicker", { kind: "open", paths: [join(folder, "a.txt")] }, cs);
  const duplicates = await cli.repliesTo(424242, duplicateMark, 3000);
  check("cli: Ardia.answerFilePicker with a pending command's id is refused and the first command still answers",
    duplicates.length === 2 && duplicates.some((m) => /still waiting/.test(m.error?.message ?? "")) && duplicates.some((m) => m.result?.result?.value === 1),
    JSON.stringify(duplicates).slice(0, 300));

  const threeTarget = (await urlsOf(plugin)).find((t) => t.url === `${origin}/three`);
  const s3 = (await plugin.send("Target.attachToTarget", { targetId: threeTarget?.targetId, flatten: true })).result?.sessionId;
  const schemes = [[`${origin}/three`, true], ["about:blank", true], ["https://127.0.0.1:1/", true], ["javascript:void 0", false], ["data:text/html,x", false], [`blob:${origin}/x`, false], ["file:///etc/hosts", false], ["chrome://version", false], [`view-source:${origin}/three`, false], [`filesystem:${origin}/temporary/x`, false], ["ftp://127.0.0.1/x", false], ["ardia://settings", false]];
  for (const [url, allowedScheme] of schemes) {
    const reply = await plugin.send("Page.navigate", { url }, s3);
    const refusedByPolicy = refused(reply) && /isn't allowed for a plugin/.test(reply.error?.message ?? "");
    check(`plugin: Page.navigate to ${url.split(":")[0]}: is ${allowedScheme ? "allowed" : "refused"}`, allowedScheme ? !refusedByPolicy : refusedByPolicy, text(reply));
  }
  const navigatedPlain = await plugin.send("Page.navigate", { url: `${origin}/three` }, s3);
  check("plugin: Page.navigate with only a web url answers", !refused(navigatedPlain), text(navigatedPlain));
  const cs3 = (await cli.send("Target.attachToTarget", { targetId: threeTarget?.targetId, flatten: true })).result?.sessionId;
  await until("page three loaded", async () => (await cli.send("Runtime.evaluate", { expression: "document.readyState === 'complete'", returnByValue: true }, cs3)).result?.result?.value);
  await cli.send("Runtime.evaluate", { expression: "window.moves = 0; window.wheels = 0; addEventListener('mousemove', () => window.moves++); addEventListener('wheel', () => window.wheels++, { passive: true }); true" }, cs3);
  const moves = async () => (await cli.send("Runtime.evaluate", { expression: "window.moves", returnByValue: true }, cs3)).result?.result?.value;
  const wheels = async () => (await cli.send("Runtime.evaluate", { expression: "window.wheels", returnByValue: true }, cs3)).result?.result?.value;
  const inWindow = (tab, win) => until(`${tab} in ${win}`, async () =>
    ((await appEval(`return ac.engine.call("tabs.strips")`))?.strips ?? []).some((s) => s.appWindow === win && s.tabs.some((t) => t.key === tab)) || null, 8000).then(() => true, () => false);
  for (let i = 0; i < 20; i++) plugin.raw(660000 + i, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 10 + i * 5, y: 10 + i * 3 }, s3);
  for (let i = 0; i < 5; i++) plugin.raw(661000 + i, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 50, y: 50, deltaX: 0, deltaY: 20 }, s3);
  const sentAt = Date.now();
  await appEval(`ac.actions.moveTabToWindow("t3", "w2"); return true`);
  const reachedOther = await inWindow("t3", "w2");
  const movesAtDeparture = await moves();
  await appEval(`ac.actions.moveTabToWindow("t3", "w1"); return true`);
  const cameBack = await inWindow("t3", "w1");
  const backBeforeDelivery = Date.now() - sentAt < 1800;
  await sleep(2500);
  const movesAfterReturn = await moves();
  const wheelsAfterReturn = await wheels();
  const outAndBack = await plugin.send("DOM.getDocument", {}, s3);
  const detachedS3 = await until("the detach of the moved session", async () => plugin.events.some((e) => e.method === "Target.detachedFromTarget" && e.params?.sessionId === s3) || null, 10000).catch(() => false);
  check("plugin: a tab moved to the other window (confirmed natively) and back stays detached", reachedOther && cameBack && !!s3 && refused(outAndBack) && detachedS3, `reached w2 ${reachedOther}, back in w1 ${cameBack}, ${text(outAndBack)}`);
  check("plugin: mouse and wheel input its departed session queued, delivered after the tab came back, never lands", backBeforeDelivery && movesAtDeparture === 0 && movesAfterReturn === 0 && wheelsAfterReturn === 0, `back before delivery ${backBeforeDelivery}, moves ${movesAtDeparture}/${movesAfterReturn}, wheels ${wheelsAfterReturn}`);
  const old = await plugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 20 }, s3);
  const fresh = (await plugin.send("Target.attachToTarget", { targetId: threeTarget?.targetId, flatten: true })).result?.sessionId;
  const freshMove = await plugin.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 30, y: 30 }, fresh);
  await sleep(300);
  check("plugin: the departed session's input is refused and a fresh attach to the returned tab takes input", refused(old) && !!fresh && !refused(freshMove) && (await moves()) > movesAfterReturn, `${text(old)} ${text(freshMove)}`);

  const t3Target = (await urlsOf(cli)).find((t) => t.url === `${origin}/three`);
  const direct = await connect(`ws://127.0.0.1:${control.port}/devtools/page/${t3Target?.targetId}?token=${encodeURIComponent(minted.credential)}`).catch(() => null);
  const directOrder = [];
  if (direct) {
    direct.ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id === 888001) directOrder.push(`reply:${m.error?.message ?? "result"}`); });
    direct.closed.then(() => directOrder.push("close"));
    direct.ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id === 888002) directOrder.push(`concurrent:${m.error?.message ?? "result"}`); });
    for (let i = 0; i < 20; i++) direct.raw(889000 + i, "Page.captureScreenshot", {});
    direct.raw(888001, "Page.navigate", { url: `${origin}/slow-three` });
    await sleep(200);
    await appEval(`ac.actions.moveTabToWindow("t3", "w2"); return true`);
    direct.raw(888002, "Page.getLayoutMetrics", {});
    await until("the direct socket to close", async () => directOrder.includes("close") || null, 8000).catch(() => null);
  }
  check("plugin: a direct page socket gets tab_out_of_scope for its command in flight before it closes", (directOrder[0] ?? "").startsWith("reply:ardia: tab_out_of_scope") && directOrder.at(-1) === "close", directOrder.join(" | ") || "no direct socket");
  check("plugin: under a backlog, a command sent during the scope close gets tab_out_of_scope before the close", directOrder.some((e) => e.startsWith("concurrent:ardia: tab_out_of_scope")) && directOrder.indexOf("close") > directOrder.findIndex((e) => e.startsWith("concurrent:")), directOrder.join(" | ") || "no direct socket");
  await appEval(`ac.actions.moveTabToWindow("t3", "w1"); return true`);
  await inWindow("t3", "w1");

  const lateMark = plugin.replies.length;
  plugin.raw(777001, "Page.navigate", { url: `${origin}/slow-one` }, ps);
  await appEval(`ac.actions.moveTabToWindow("t1", "w2"); return true`);
  const late = await plugin.repliesTo(777001, lateMark, 4000);
  const returned = await appEval(`const t = Object.values(ac.store.getState().tabs).find((x) => x?.url?.endsWith("/four")); if (t) ac.actions.moveTabToWindow(t.id, "w1"); return !!t`);
  await sleep(1500);
  const orphan = (await plugin.send("Target.getTargets")).result?.targetInfos?.find((t) => t.url === `${origin}/four`);
  check("plugin: a target whose opener left its window shows no opener", returned === true && !!orphan && !orphan.openerId && !orphan.openerFrameId && orphan.canAccessOpener !== true, JSON.stringify(orphan ?? null).slice(0, 300));
  check("plugin: a reply that finishes after its tab moved never reaches it; it gets exactly one tab_out_of_scope error",
    late.length === 1 && (late[0].error?.message ?? "").startsWith("ardia: tab_out_of_scope") && !late.some((m) => m.result), JSON.stringify(late).slice(0, 300));
  const detached = await until("the detach event", async () => plugin.events.find((e) => e.method === "Target.detachedFromTarget" && e.params?.sessionId === ps) ?? null, 12000).catch(() => null);
  check("plugin: its session on the moved tab is detached with Target.detachedFromTarget", !!detached);
  const afterMove = await plugin.send("DOM.getDocument", {}, ps);
  check("plugin: the moved tab's session takes no more commands", refused(afterMove), text(afterMove));
  const seenAfterMove = (await urlsOf(plugin)).map((t) => t.url);
  check("plugin: Target.getTargets no longer lists the moved tab", !seenAfterMove.includes(`${origin}/one`), seenAfterMove.join(" "));

  const cliCookies = await cli.send("Network.getCookies", {}, cliTwo.result?.sessionId);
  check("cli: still gets everything after a plugin connected (Network.getCookies)", !refused(cliCookies), text(cliCookies));

  const drained = orphan && (await connect(`ws://127.0.0.1:${control.port}/devtools/page/${orphan.targetId}?token=${encodeURIComponent(minted.credential)}`).catch(() => null));
  let drainedReplies = 0;
  let drainedClosedAt = 0;
  if (drained) {
    drained.ws.addEventListener("message", () => drainedReplies++);
    drained.closed.then(() => (drainedClosedAt = Date.now()));
    for (let i = 0; i < 20; i++) drained.raw(890000 + i, "Page.captureScreenshot", {});
    await appEval(`const t = Object.values(ac.store.getState().tabs).find((x) => x?.url?.endsWith("/four")); if (t) ac.actions.moveTabToWindow(t.id, "w2"); return !!t`);
  }
  const pluginAlive = await plugin.send("Target.getTargets");
  check("plugin: its browser connection stays open after the detach", !refused(pluginAlive), text(pluginAlive));
  const revokeStarted = Date.now();
  const revoked = await appEval(`return ac.engine.call("engine.cliPluginCredential", { revoke: ${JSON.stringify(minted.id)} })`);
  const closedInTime = await Promise.race([plugin.closed.then(() => true), sleep(5000).then(() => false)]);
  check("revoking the credential closes its connection", revoked?.revoked === true && closedInTime, JSON.stringify(revoked));
  await until("the draining socket to close", async () => drainedClosedAt || null, 4000).catch(() => null);
  check("plugin: a revoke during a scope close closes the draining socket at once", !!drained && drainedClosedAt > 0 && drainedClosedAt - revokeStarted < 2000 && drainedReplies <= 20, drained ? `closed after ${drainedClosedAt ? drainedClosedAt - revokeStarted : "never"} ms, ${drainedReplies} replies` : "no socket");
  const again = await connect(`${base}?token=${encodeURIComponent(minted.credential)}`).then(() => "accepted", () => "refused");
  check("a revoked credential can't connect again", again === "refused", again);
  const cliAlive = await cli.send("Browser.getVersion");
  check("cli: its connection is untouched by the revoke", !refused(cliAlive), text(cliAlive));
  cli.ws.close();
} finally {
  server.close();
  if (pid) try { process.kill(pid); } catch {}
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
