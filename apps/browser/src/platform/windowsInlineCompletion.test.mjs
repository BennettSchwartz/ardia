import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsInlineCompletion } from "../../../../packages/expo-windows/src/inlineCompletion.ts";
import { consentToken, setConsentPeriod } from "../state/telemetry/consentPeriod.ts";
import { noteInlineCompletionShown, noteRoutesListed, takeInlineCompletionCounts } from "../state/telemetry/inlineCompletionCounts.ts";

const completing = (host) => windowsInlineCompletion(() => host).complete(7, "exa", "mple.com");

test("Windows shows the completion only when no IME composition is under way", async () => {
  assert.equal(await completing({ textComposing: async () => false }), 1);
  assert.equal(await completing({ textComposing: async () => true }), 0);
  assert.equal(await completing({ textComposing: () => Promise.reject(new Error("gone")) }), 0);
  assert.equal(await completing(null), 0);
});

test("inline completions shown are counted and reset once taken", () => {
  takeInlineCompletionCounts();
  noteInlineCompletionShown();
  noteInlineCompletionShown();
  assert.deepEqual(takeInlineCompletionCounts(), { command_bar_inline_completions: 2, command_bar_site_suggestions: 0, command_bar_routes_listed: 0, command_bar_letters_restored: 0, command_bar_rows_held: 0, command_bar_key_holds: 0, command_bar_keys_replayed: 0, command_bar_replay_guards_expired: 0 });
  assert.deepEqual(takeInlineCompletionCounts(), { command_bar_inline_completions: 0, command_bar_site_suggestions: 0, command_bar_routes_listed: 0, command_bar_letters_restored: 0, command_bar_rows_held: 0, command_bar_key_holds: 0, command_bar_keys_replayed: 0, command_bar_replay_guards_expired: 0 });
});

test("command bar lists that show several routes of one site apart are counted and reset once taken", () => {
  takeInlineCompletionCounts();
  noteRoutesListed();
  noteRoutesListed();
  assert.equal(takeInlineCompletionCounts().command_bar_routes_listed, 2);
  assert.equal(takeInlineCompletionCounts().command_bar_routes_listed, 0);
});

test("a route list is counted only while the consent period it was seen in is still the current one", () => {
  setConsentPeriod(true, "routes-first");
  const seen = consentToken();
  takeInlineCompletionCounts();
  noteRoutesListed(seen);
  assert.equal(takeInlineCompletionCounts().command_bar_routes_listed, 1, "seen and counted in the same period");
  setConsentPeriod(true, "routes-second");
  noteRoutesListed(seen);
  assert.equal(takeInlineCompletionCounts().command_bar_routes_listed, 0, "seen in an earlier period: not counted in this one");
  noteRoutesListed(consentToken());
  assert.equal(takeInlineCompletionCounts().command_bar_routes_listed, 1, "seen in this period");
  setConsentPeriod(false, null);
  noteRoutesListed(consentToken());
  assert.equal(takeInlineCompletionCounts().command_bar_routes_listed, 0, "sharing off: nothing counted");
});

test("on Windows a completion needs the caret right after what was typed, as the Mac's field checks", async () => {
  const { caretAllowsInline } = await import("./inlineSelection.windows.ts");
  assert.equal(caretAllowsInline(3, 3, 3), true);
  assert.equal(caretAllowsInline(3, 11, 3), true);
  assert.equal(caretAllowsInline(3, 3, 4), false);
  assert.equal(caretAllowsInline(0, 4, 4), false);
  const mac = await import("./inlineSelection.ts");
  assert.equal(mac.caretAllowsInline(0, 0, 4), true);
});
