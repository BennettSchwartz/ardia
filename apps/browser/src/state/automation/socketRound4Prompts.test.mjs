import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, socketClient, freshWindow, controlOn, tick } = await import("./fixtures/socketHarness.mjs");
const { runMethod } = await import("./controlSocket.ts");
const { openLittleArdia } = await import("../littleArdia/actions.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const dialogs = shellNativeModules.ArdiaDialogs;
const appWindows = shellNativeModules.ArdiaAppWindows;
const originals = { confirm: dialogs.confirm, dismiss: dialogs.dismissShownOnly, animate: appWindows.animateWindowClose };
after(() => {
  Object.assign(dialogs, { confirm: originals.confirm, dismissShownOnly: originals.dismiss });
  appWindows.animateWindowClose = originals.animate;
  S().updateSettings({ cliControl: false });
});

const { fire } = socketClient(93);
const other = socketClient(94);

test("overlapping closes where a tab arrives leave no stale last-window marker", async () => {
  const { windowId: first } = await freshWindow();
  const second = S().createWindow({ url: "https://two.example/" });
  S().updateSettings({ warnBeforeClosingWindow: false });
  const finishing = new Map();
  appWindows.animateWindowClose = (id) => new Promise((resolve) => finishing.set(id, resolve));
  try {
    const closes = [fire("windows.close", { window: first }), other.fire("windows.close", { window: second })];
    for (let i = 0; i < 50 && finishing.size < 2; i++) await tick();
    finishing.get(first)();
    for (let i = 0; i < 10; i++) await tick();
    S().newTab(second, { url: "https://arrived.example/", background: true });
    finishing.get(second)();
    await Promise.all(closes);
    assert.ok(S().windows[second], "the window a tab arrived in stayed open");
    assert.equal(S().closedWindows.filter((c) => c.lastWindow).length, 0, "no marker while a regular window is open");
    S().closeWindow(second, { keepsLastWindow: true });
    assert.equal(S().closedWindows.filter((c) => c.lastWindow).length, 1, "the true last window carries it");
  } finally {
    appWindows.animateWindowClose = originals.animate;
  }
});

test("background run resolves its target as the dispatcher does: Peek, Little Ardia, the main window", async () => {
  const { windowId, tab } = await freshWindow();
  S().updateSettings({ warnBeforeClosingLastTab: true, warnBeforeClosingTabGroup: true });
  S().openPeek(tab, "https://peeked.example/");
  assert.ok(!runMethod({ command: "closeTab", window: windowId }, true).error, "closeTab with a Peek shown closes the Peek, which asks nothing");
  for (let i = 0; i < 10; i++) await tick();
  assert.ok(S().windows[windowId]);
  assert.equal(runMethod({ command: "closeTab", window: windowId }, true).error?.code, "refused", "without the Peek it's the last tab, which asks");

  S().createGroup([tab]);
  const little = openLittleArdia("https://l.example/");
  assert.equal(runMethod({ command: "closeTabGroup", window: little }, true).error?.code, "refused", "Little Ardia sends it to the main window, whose tab is in a group");
  assert.ok(!runMethod({ command: "closeTab", window: little }, true).error, "closing Little Ardia asks nothing in the background");

  assert.equal(runMethod({ command: "openFile", window: windowId }, true).error?.code, "refused", "a file picker nobody can see");
  for (const command of ["exportBookmarks", "savePage", "printWithSystemDialog", "share"]) {
    assert.equal(runMethod({ command, window: windowId }, true).error?.code, "refused", command);
  }
  S().updateSettings({ warnBeforeClosingLastTab: false, warnBeforeClosingTabGroup: false });
});

function heldConfirms() {
  const waiting = [];
  let dismissed = 0;
  dialogs.confirm = (options) => new Promise((resolve) => waiting.push({ options, resolve }));
  dialogs.dismissShownOnly = () => {
    dismissed++;
    for (const w of waiting.splice(0)) w.resolve({ confirmed: false, suppressed: false });
    return Promise.resolve();
  };
  return { waiting, dismissed: () => dismissed };
}

test("turning control off dismisses the socket's questions, answers refused and frees the close guard", async () => {
  const { windowId } = await freshWindow();
  S().createWindow({ url: "https://other.example/" });
  S().newTab(windowId, { url: "https://b.example/", background: true });
  S().newTab(windowId, { url: "https://c.example/", background: true });
  S().updateSettings({ warnBeforeClosingWindow: true });
  const work = S().createProfile({ name: "Work" });
  const held = heldConfirms();
  try {
    const closing = fire("windows.close", { window: windowId });
    const deleting = other.fire("profiles.delete", { profile: work });
    for (let i = 0; i < 50 && held.waiting.length < 2; i++) await tick();
    assert.equal(held.waiting.length, 2, "both asked");
    S().updateSettings({ cliControl: false });
    const [closed, deleted] = await Promise.all([closing, deleting]);
    assert.ok(held.dismissed() >= 1, "the sheets were dismissed");
    assert.equal(closed.error?.code, "refused", JSON.stringify(closed));
    assert.equal(deleted.error?.code, "refused", JSON.stringify(deleted));
    assert.ok(S().windows[windowId] && S().profiles[work]);

    await controlOn();
    const again = fire("windows.close", { window: windowId });
    for (let i = 0; i < 50 && !held.waiting.length; i++) await tick();
    assert.equal(held.waiting.length, 1, "the close guard was released, so Ardia asks again");
    held.waiting[0].resolve({ confirmed: true, suppressed: false });
    assert.ok(!(await again).error);
  } finally {
    Object.assign(dialogs, { confirm: originals.confirm, dismissShownOnly: originals.dismiss });
  }
});
