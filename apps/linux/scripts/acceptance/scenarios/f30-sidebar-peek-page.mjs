import assert from "node:assert/strict";
import { startBrowser } from "../lib/flows.mjs";
import { sessionSeed } from "../lib/seed.mjs";
import { js, pause } from "../lib/util.mjs";

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
    await pause(1200);
    await t.check("the page is never hidden while the sidebar peeks out", async () => {
      await shell.eval(`(() => {
        const sent = globalThis.sidebarPeekViewports = [];
        const frames = globalThis.sidebarPeekFrames = [];
        const send = chrome.send.bind(chrome);
        chrome.send = (name, params) => {
          const call = params?.[2];
          if (call?.method === "tab.viewport") sent.push(call.args.visible);
          return send(name, params);
        };
        const end = performance.now() + 2500;
        const sample = () => {
          frames.push(!!document.querySelector('[data-testid="ardia-sidebar-peek"]'));
          if (performance.now() < end) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
        return true;
      })()`);
      for (const x of [600, 300, 100, 40, 10, 2]) {
        await shell.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: 400 });
        await pause(30);
      }
      await pause(1500);
      const sent = await shell.eval("globalThis.sidebarPeekViewports");
      const frames = await shell.eval("globalThis.sidebarPeekFrames");
      await t.evidence("viewports", { sent, peekFrames: frames.filter(Boolean).length });
      await t.screenshot(shell, "peek");
      assert.ok(frames.some(Boolean), "the sidebar must actually peek out");
      assert.ok(!sent.includes(false), `the page was hidden during the peek: ${js(sent)}`);
      return { viewports: sent.length, peekFrames: frames.filter(Boolean).length };
    });
  },
};
