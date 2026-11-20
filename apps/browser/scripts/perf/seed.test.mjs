import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSeed } from "./seed.mjs";

const sessionOf = (seed) => (typeof seed["session.json"] === "string" ? JSON.parse(seed["session.json"]) : seed["session.json"]);
const hostOf = (url) => new URL(url).host;

test("the session's active tabs load from the bench origin and every other tab from its own host, so Chromium's same-host favicon fallback can't race into the launch counts", () => {
  const session = sessionOf(buildSeed("http://127.0.0.1:47817", "", "http://[::1]:47817"));
  const active = new Set(Object.values(session.windows[0].activeTabIds));
  assert.equal(active.size, 2);
  for (const tab of session.tabs) {
    assert.equal(hostOf(tab.url), active.has(tab.id) ? "127.0.0.1:47817" : "[::1]:47817", tab.id);
    if (tab.pinnedUrl) assert.equal(tab.pinnedUrl, tab.url, `${tab.id} keeps its pinned URL`);
  }
});

test("without a tab origin the seed keeps every tab on the bench origin, as micro-bench and census build it", () => {
  const session = sessionOf(buildSeed("http://127.0.0.1:47817"));
  assert.ok(session.tabs.every((tab) => hostOf(tab.url) === "127.0.0.1:47817"));
});
