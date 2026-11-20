import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, loadSession, startPersistence } = await import("../session/persist.ts");
const stub = await import("../../test-native/index.ts");
const { adoptParkedPins } = await import("./parkedPins.ts");

const S = () => useBrowser.getState();
const PAGE = "https://example.com/page";
const NOTES = "https://example.com/page#notes";
const pinsIn = (w, profileId = S().windows[w].profileId) =>
  S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.pin && t.profileId === profileId).map((t) => [t.pinnedUrl ?? t.url, t.pin.as]);

function twoPinsOfOnePage(w, profileId) {
  const one = S().newTab(w, { url: PAGE, profileId, background: true });
  const two = S().newTab(w, { url: NOTES, profileId, background: true });
  S().pinTabs([one], true);
  S().pinTabs([two], true);
  return [one, two];
}

test("closing a profile's last window parks both pins of one page, and both come back (#3149)", () => {
  S().hydrate({});
  const a = S().createWindow({ url: "https://a1.com" });
  const b = S().createWindow({ url: "https://b1.com" });
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(b, work);
  twoPinsOfOnePage(b, work);
  S().closeWindow(b);
  assert.deepEqual(S().parkedPins[work]?.tabs.map((t) => t.url).sort(), [PAGE, NOTES]);
  S().switchProfile(a, work);
  assert.deepEqual(pinsIn(a, work).map(([u]) => u).sort(), [PAGE, NOTES]);
});

test("launching with Restore Session off keeps both pins of one page (#3149)", () => {
  stub.docs.clear();
  const stop = startPersistence();
  const w = S().createWindow({ url: "https://a1.com" });
  twoPinsOfOnePage(w, S().windows[w].profileId);
  S().updateSettings({ restoreSession: false });
  flushPersistence();
  stop();
  S().hydrate(loadSession());
  const n = S().createWindow();
  assert.deepEqual(pinsIn(n).map(([u]) => u).sort(), [PAGE, NOTES]);
});

test("adopting parked pins next to a pin of the same page keeps both; the same pin isn't added twice (#3149)", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a1.com" });
  const profileId = S().windows[w].profileId;
  const one = S().newTab(w, { url: PAGE, background: true });
  S().pinTabs([one], true);
  const kept = S().tabs[one];
  const parked = { tabs: [{ ...kept, id: one, groupId: null }, { ...kept, url: NOTES, pinnedUrl: NOTES, id: "parked-notes", groupId: null }], groups: [] };
  useBrowser.setState(adoptParkedPins({ ...S(), parkedPins: { [profileId]: parked } }, w, profileId));
  assert.deepEqual(pinsIn(w).map(([u]) => u).sort(), [PAGE, NOTES]);
});
