import assert from "node:assert/strict";
import { test } from "node:test";
const { forgetSettingsScroll, goToSettingsPane, noteSettingsPageScroll, replaceSettingsPlace, settingsBack, settingsForward, settingsPageKey, useSettingsNav } = await import("./settingsWindows.ts");

const nav = () => useSettingsNav.getState();
const scrollShown = (y) => noteSettingsPageScroll(settingsPageKey(nav()), y);

function fresh() {
  useSettingsNav.setState({ pane: "general", profileId: null, detail: null, scroll: 0, back: [], forward: [] });
  noteSettingsPageScroll("", 0);
}

test("Back returns to the parent pane where it was left, Forward to the sub-page's own spot", () => {
  fresh();
  goToSettingsPane("profiles", "default");
  scrollShown(520);
  goToSettingsPane("profiles", "default", "passwords");
  assert.equal(nav().scroll, 0);
  scrollShown(240);
  settingsBack();
  assert.equal(nav().detail, null);
  assert.equal(nav().scroll, 520);
  settingsForward();
  assert.equal(nav().detail, "passwords");
  assert.equal(nav().scroll, 240);
});

test("each pane keeps its own position across several steps", () => {
  fresh();
  scrollShown(700);
  goToSettingsPane("general", null, "crashDetails");
  scrollShown(90);
  goToSettingsPane("plugins");
  scrollShown(300);
  goToSettingsPane("plugins", null, "some-plugin");
  settingsBack();
  assert.equal(nav().scroll, 300);
  settingsBack();
  assert.equal(nav().scroll, 90);
  settingsBack();
  assert.equal(nav().pane, "general");
  assert.equal(nav().scroll, 700);
});

test("a pane opened fresh starts at the top", () => {
  fresh();
  scrollShown(700);
  goToSettingsPane("tabs");
  assert.equal(nav().scroll, 0);
  goToSettingsPane("general");
  assert.equal(nav().scroll, 0);
});

test("a position noted for another page is not taken for the one being left", () => {
  fresh();
  noteSettingsPageScroll("tabs::", 400);
  goToSettingsPane("tabs");
  settingsBack();
  assert.equal(nav().scroll, 0);
});

test("leaving a sub-page in place lands on the parent's spot, closing Settings forgets the shown one", () => {
  fresh();
  goToSettingsPane("profiles", "default");
  scrollShown(360);
  goToSettingsPane("profiles", "default", "extension:abc");
  replaceSettingsPlace("default", null);
  assert.equal(nav().scroll, 360);
  forgetSettingsScroll();
  assert.equal(nav().scroll, 0);
});
