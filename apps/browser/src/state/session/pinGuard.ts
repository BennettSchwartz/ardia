import type { BrowserState } from "../browser/store";
import { isIncognitoProfile, pinKeyOf } from "../browser/model";
import { parkWindowPins } from "../pins/parkedPins";
import { isRegularWindow } from "../windows/small";
import { isFields } from "../../lib/decode";
import { readDocument, saveDocument } from "../../platform/documents";
import type { ParkedPins } from "../browser/types";
import { consentToken, type ConsentToken } from "../telemetry/client";

export const PINS_BACKUP_DOCUMENT = "pins-backup.json";
export const PINS_BACKUP_VERSION = 1;
export const MAX_PIN_BACKUPS = 20;

export type PinState = Pick<BrowserState, "windows" | "tabs" | "groups" | "splits" | "parkedPins" | "profiles" | "history">;
export type PinCensus = Map<string, Set<string>>;
export type PinBackup = { at: number; dropped: Record<string, number>; pins: Record<string, ParkedPins> };
export type PinBackups = { version: number; backups: PinBackup[] };

export const pinSources = (s: PinState): unknown[] => [s.windows, s.tabs, s.groups, s.splits, s.parkedPins];

export function pinCensus(s: PinState): PinCensus {
  const census: PinCensus = new Map();
  const add = (profileId: string, key: string) => {
    if (isIncognitoProfile(profileId)) return;
    const keys = census.get(profileId);
    if (keys) keys.add(key);
    else census.set(profileId, new Set([key]));
  };
  for (const w of Object.values(s.windows)) {
    if (!isRegularWindow(w)) continue;
    for (const id of w.tabIds) {
      const t = s.tabs[id];
      if (t?.pin) add(t.profileId, `t:${pinKeyOf(t)}`);
    }
  }
  for (const g of Object.values(s.groups)) {
    if (!g.pinned || !isRegularWindow(s.windows[g.windowId])) continue;
    add(g.profileId, `g:${pinKeyOf(g)}`);
    for (const id of g.tabIds) {
      const t = s.tabs[id];
      if (t) add(t.profileId, `t:${pinKeyOf(t)}`);
    }
  }
  for (const [profileId, park] of Object.entries(s.parkedPins)) {
    for (const t of park.tabs) add(profileId, `t:${t.id}`);
    for (const g of park.groups) add(profileId, `g:${g.id}`);
  }
  return census;
}

export function droppedPins(before: PinCensus, after: PinCensus, profiles: PinState["profiles"]): Map<string, number> {
  const dropped = new Map<string, number>();
  for (const [profileId, keys] of before) {
    if (!profiles[profileId]) continue;
    const now = after.get(profileId);
    let gone = 0;
    for (const key of keys) if (!now?.has(key)) gone++;
    if (gone) dropped.set(profileId, gone);
  }
  return dropped;
}

export function pinsOf(s: PinState, profileIds: string[]): Record<string, ParkedPins> {
  const wanted = new Set(profileIds);
  const profilesIn = (w: PinState["windows"][string]) => w.tabIds.some((id) => wanted.has(s.tabs[id]?.profileId ?? ""));
  let live: Record<string, ParkedPins> = {};
  for (const w of Object.values(s.windows)) if (isRegularWindow(w) && profilesIn(w)) live = parkWindowPins(live, w, { ...s, windows: { [w.id]: w } });
  const pins: Record<string, ParkedPins> = {};
  for (const profileId of wanted) {
    const own = live[profileId] ?? { tabs: [], groups: [] };
    const old = s.parkedPins[profileId] ?? { tabs: [], groups: [] };
    const tabIds = new Set(own.tabs.map((t) => t.id));
    const groupIds = new Set(own.groups.map((g) => g.id));
    const tabs = [...own.tabs, ...old.tabs.filter((t) => !tabIds.has(t.id))].map(({ restoreFrom: _, ...t }) => t);
    const groups = [...own.groups, ...old.groups.filter((g) => !groupIds.has(g.id))];
    const splits = [...(own.splits ?? []), ...(old.splits ?? [])];
    if (tabs.length || groups.length) pins[profileId] = { tabs, groups, ...(splits.length ? { splits } : {}) };
  }
  return pins;
}

export function parsePinBackups(json: string | null | undefined): PinBackup[] {
  try {
    const raw: unknown = json ? JSON.parse(json) : null;
    if (!isFields(raw) || !Array.isArray(raw.backups)) return [];
    return raw.backups.filter((b): b is PinBackup => isFields(b) && isFields(b.pins) && isFields(b.dropped));
  } catch {
    return [];
  }
}


export const PIN_BACKUP_WAIT_MS = 2_000;
export const MAX_PIN_BACKUP_WAIT_MS = 60_000;

export type PinCheck = { hold: false; commit: () => void } | { hold: true; againIn: number | null };
export type PinGuard = ((s: PinState) => PinCheck) & { landing: () => Promise<void> | null };
type Cover = { baseline: PinState; base: PinBackup[]; at: number; dropped: Map<string, number> };

const NOTHING: PinCheck = { hold: false, commit: () => {} };

function savedBackups(): PinBackup[] {
  try {
    return parsePinBackups(readDocument(PINS_BACKUP_DOCUMENT));
  } catch {
    return [];
  }
}

function coverJson(cover: Cover): string {
  const entry: PinBackup = { at: cover.at, dropped: Object.fromEntries(cover.dropped), pins: pinsOf(cover.baseline, [...cover.dropped.keys()]) };
  return JSON.stringify({ version: PINS_BACKUP_VERSION, backups: [...cover.base, entry].slice(-MAX_PIN_BACKUPS) });
}

export function pinGuard(initial: PinState, saveAgain: (delay: number) => void, noteBackup: (pins: number, consent: ConsentToken | null) => void): PinGuard {
  let saved = initial;
  let sourcesSaved = pinSources(saved);
  let censusSaved: PinCensus | null = null;
  let cover: Cover | null = null;
  let landed = new Set<string>();
  let landing: Promise<void> | null = null;
  let failures = 0;
  let againAt = 0;

  const stage = (staged: Cover) => {
    const profiles = [...staged.dropped.keys()];
    const consent = consentToken();
    let attempt: Promise<void>;
    try {
      attempt = saveDocument(PINS_BACKUP_DOCUMENT, coverJson(staged));
    } catch (error) {
      attempt = Promise.reject(error);
    }
    landing = attempt.then(
      () => {
        landing = null;
        failures = 0;
        againAt = 0;
        if (cover === staged) {
          const fresh = profiles.filter((p) => !landed.has(p));
          for (const p of fresh) landed.add(p);
          if (fresh.length) noteBackup(fresh.reduce((a, p) => a + (staged.dropped.get(p) ?? 0), 0), consent);
        }
        saveAgain(0);
      },
      () => {
        landing = null;
        failures++;
        const delay = Math.min(MAX_PIN_BACKUP_WAIT_MS, PIN_BACKUP_WAIT_MS * 2 ** (failures - 1));
        againAt = Date.now() + delay;
        saveAgain(delay);
      },
    );
  };

  const check = (s: PinState): PinCheck => {
    const sources = pinSources(s);
    if (sources.every((v, i) => v === sourcesSaved[i])) return NOTHING;
    const census = pinCensus(s);
    const dropped = droppedPins(censusSaved ?? pinCensus(saved), census, s.profiles);
    if (cover && cover.baseline !== saved) {
      cover = null;
      landed = new Set();
    }
    const missing = [...dropped].filter(([p]) => !landed.has(p));
    if (missing.length) {
      cover ??= { baseline: saved, base: savedBackups(), at: Date.now(), dropped: new Map() };
      let grew = false;
      for (const [p, n] of missing) {
        if (cover.dropped.has(p)) continue;
        cover.dropped.set(p, n);
        grew = true;
      }
      if (landing) return { hold: true, againIn: null };
      const wait = againAt - Date.now();
      if (wait > 0 && !grew) return { hold: true, againIn: wait };
      stage(cover);
      return { hold: true, againIn: null };
    }
    return {
      hold: false,
      commit: () => {
        saved = s;
        sourcesSaved = sources;
        censusSaved = census;
        cover = null;
        landed = new Set();
      },
    };
  };
  return Object.assign(check, { landing: () => landing });
}

export async function savedAfterPins(flush: () => boolean, held: () => boolean, landing: () => Promise<void> | null): Promise<boolean> {
  if (!flush()) return false;
  for (let waiting = landing(); held() && waiting; waiting = landing()) {
    await waiting;
    if (!flush()) return false;
  }
  return !held();
}

export async function landHeldPins(held: () => boolean, landing: () => Promise<void> | null, saveNow: () => void): Promise<void> {
  const waiting = held() ? landing() : null;
  if (!waiting) return;
  await waiting;
  saveNow();
}
