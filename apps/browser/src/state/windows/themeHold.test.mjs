import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { updateLive } = await import("../tabs/actions.ts");
const { liveOf, onLiveChange } = await import("../tabs/tabLive.ts");
const { heldThemeColor, COMMIT_THEME_HOLD_MS } = await import("./launchLook.ts");

const S = () => useBrowser.getState();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function tabShowing(color) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://blue.example/one" });
  const tab = S().windows[w].tabIds[0];
  updateLive(tab, { themeColor: color });
  const changes = [];
  const stop = onLiveChange((id, live, prev) => {
    if (id === tab && live.themeColor !== prev.themeColor) changes.push(live.themeColor);
  });
  const navigate = (url, reported, isLoading = false) => updateLive(tab, { themeColor: heldThemeColor(tab, url, reported, isLoading) });
  return { tab, changes, navigate, stop };
}

test("a commit that reports no theme colour before the page's own makes no store update when the colour is the same", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://blue.example/two", null, true);
  await sleep(8);
  t.navigate("https://blue.example/two", "#336699", true);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.deepEqual(t.changes, [], "no flash: the tint never drops");
  assert.equal(liveOf(t.tab).themeColor, "#336699");
  t.stop();
});

test("a page of another colour changes the tint once, not twice", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://red.example/", null, true);
  await sleep(8);
  t.navigate("https://red.example/", "#993333", true);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.deepEqual(t.changes, ["#993333"]);
  t.stop();
});

test("a page with no theme colour clears the tint once the hold ends, and not before", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://plain.example/", null, true);
  t.navigate("https://plain.example/", null, false);
  assert.equal(liveOf(t.tab).themeColor, "#336699", "held through the commit");
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.equal(liveOf(t.tab).themeColor, null, "cleared one beat later");
  assert.deepEqual(t.changes, [null]);
  t.navigate("https://plain.example/next", null, false);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.deepEqual(t.changes, [null], "an uncoloured page after an uncoloured one holds nothing");
  t.stop();
});

test("a tab closed during the hold is left alone", async () => {
  const t = tabShowing("#336699");
  t.navigate("https://plain.example/", null, true);
  S().closeTab(t.tab);
  await sleep(COMMIT_THEME_HOLD_MS + 20);
  assert.equal(S().tabs[t.tab], undefined);
  t.stop();
});
