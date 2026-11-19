import assert from "node:assert/strict";
import { startBrowser } from "../lib/flows.mjs";
import { sessionSeed } from "../lib/seed.mjs";
import { js, pause } from "../lib/util.mjs";

const EDGE_PATHS = { left: [600, 300, 100, 40, 10, 2], right: [300, 600, 800, 860, 890, 898] };
const CASES = [
  { side: "left", addressBar: "toolbar" },
  { side: "right", addressBar: "toolbar" },
  { side: "left", addressBar: "sidebar" },
];

export default {
  id: "F30",
  issue: 2736,
  title: "Peeking the hidden sidebar keeps the page drawn under it",
  deadline: 180000,
  async run(t) {
    const url = t.fixtures.url.page(1, "sidebar-peek");
    const { app, shell } = await startBrowser(t, { session: sessionSeed({ windows: [{ id: "main", urls: [url] }] }) });
    await shell.state(`s.activate("main-tab-0"); s.setFocusedWindow(windowId); return true;`);
    await app.pageLoaded(url);
    await shell.command("toggleSidebar");
    await shell.waitState(`return (s.windows[windowId]?.autoHideTabs ?? s.settings.autoHideTabs) === true;`, { label: "Auto-hide tabs on" });
    for (const { side, addressBar } of CASES) {
      await t.check(`the page is never hidden while a ${side} sidebar with the address bar in the ${addressBar} peeks out and slides away`, async () => {
        await shell.state(`s.updateSettings({ sidebarSide: ${js(side)}, addressBar: ${js(addressBar)} }); return true;`);
        await shell.waitState(`return s.settings.sidebarSide === ${js(side)} && s.settings.addressBar === ${js(addressBar)};`, { label: `sidebar on the ${side}, address bar in the ${addressBar}` });
        await pause(1200);
        const width = await shell.eval("window.innerWidth");
        const path = side === "left" ? EDGE_PATHS.left : EDGE_PATHS.right.map((x) => width - (900 - x));
        await shell.eval(`(() => {
          const record = globalThis.sidebarPeekRecord = { sent: [], requests: 0, peekFrames: 0, stopped: false };
          const send = chrome.send.bind(chrome);
          chrome.send = (name, params) => {
            const call = params?.[2];
            if (name === "ardiaRequest") record.requests++;
            if (call?.method === "tab.viewport") record.sent.push(call.args.visible);
            return send(name, params);
          };
          const sample = () => {
            if (record.stopped) return void (chrome.send = send);
            if (document.querySelector('[data-testid="ardia-sidebar-peek"]')) record.peekFrames++;
            requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
          return true;
        })()`);
        for (let round = 0; round < 2; round++) {
          for (const x of path) {
            await shell.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400 });
            await pause(30);
          }
          await pause(900);
          await shell.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(width / 2), y: 400 });
          await pause(900);
        }
        const record = await shell.eval("(() => { const r = globalThis.sidebarPeekRecord; r.stopped = true; return { sent: r.sent, requests: r.requests, peekFrames: r.peekFrames }; })()");
        await t.evidence(`viewports-${side}-${addressBar}`, record);
        await t.screenshot(shell, `peek-${side}-${addressBar}`);
        assert.ok(record.peekFrames > 0, "the sidebar must actually peek out");
        assert.ok(record.requests > 0, "the host requests must pass through the recorder");
        assert.ok(!record.sent.includes(false), `the page was hidden during the peek: ${js(record.sent)}`);
        return { viewports: record.sent.length, peekFrames: record.peekFrames };
      });
    }
  },
};
