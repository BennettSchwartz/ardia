import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { useStore, type StoreApi } from "zustand";
import { entryId, entryKey } from "../../state/sidebar/entryKey";
import { entryHeightsNow, keptEntryIndices, useBoxHeights, useKeptTabs } from "../../state/sidebar/listWindow";
import { offerLanding, watchRevealTargets } from "../../state/sidebar/reveal";
import { useSidebarUi } from "../../state/sidebar/sidebarUi";
import { noDragMarks, type DragMarks } from "../../state/sidebar/dragMarks";
import { useScreenReader } from "../../state/app/screenReader";
import { noteSidebarRowsMounted } from "../../state/telemetry/sidebarScrollCounts";
import { layout } from "../ui/theme";
import { shiftedBand, type ListBand, type ListViewport } from "./listViewport";
import { arrivalBand, arrivalSide, holdsForArrival, listGeometry, mountedIndices, nextWindow, runwayScreens, travelAfter, windowPieces, type ListGeometry, type Travel } from "./listWindow";

export const ASIDE_SETTLE_MS = 1500;
export const ASIDE_WAKE_MS = 600;
export const ARRIVAL_MS = 1000;
export const LAYOUT_SETTLE_MS = 450;
const ASIDE_AHEAD = { above: 0, below: 0.25 } as const;

export type ListWindow = { mounted: string[]; before: Map<string, number>; after: number; geometry: ListGeometry };

type Options = {
  windowId: string;
  profileId: string;
  list: string[];
  viewport: ListViewport | null;
  above: number;
  current: boolean;
  firstPaint: number;
  marks: StoreApi<DragMarks> | undefined;
  moving: () => string[];
};

const NO_TABS: string[] = [];

export function useListWindow({ windowId, profileId, list, viewport, above, current, firstPaint, marks, moving }: Options): ListWindow | null {
  const reader = useScreenReader();
  const shown = useRef<{ geometry: ListGeometry; indices: number[]; window: ListWindow } | null>(null);
  const boxes = useMemo(() => list.filter((e) => entryId(e, "group") !== null), [list]);
  const boxHeights = useBoxHeights(windowId, profileId, boxes);
  const rowGap = layout.rowGap;
  const geometry = useMemo(() => listGeometry(entryHeightsNow(windowId, profileId, list), rowGap), [list, boxHeights, rowGap, windowId, profileId]);
  const index = useMemo(() => new Map(list.map((e, i) => [e, i])), [list]);
  const tabs = useKeptTabs(windowId, profileId);
  const renaming = useSidebarUi((u) => (u.renaming?.windowId === windowId && u.renaming.kind !== "folder" ? entryKey(u.renaming.kind, u.renaming.id) : null));
  const hovered = useSidebarUi((u) => (u.hover?.windowId === windowId && u.hover.kind === "tab" ? u.hover.id : null));
  const dragged = useStore(marks ?? noDragMarks, (m) => [...m.sources].join("\n"));

  const read = () => shiftedBand(viewport?.view() ?? null, above);
  const [aside, setAside] = useState(!current);
  useEffect(() => {
    const timer = setTimeout(() => setAside(!current), current ? ASIDE_WAKE_MS : ASIDE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [current]);
  const [band, setBand] = useState<ListBand>(() => nextWindow(null, read(), firstPaint));
  const placed = useRef(band);
  const travel = useRef<Travel>({ up: false, turn: 0 });
  const arrival = useRef<ListBand | null>(null);
  const follow = useRef(() => {});
  const seen = useRef({ top: 0, at: 0, runway: 0 });
  const [arriving, setArriving] = useState<string | null>(null);
  const side = useRef<{ tabId: string; side: -1 | 0 | 1 } | null>(null);
  const landed = useRef<(() => void)[]>([]);
  const [, settle] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    for (const ready of landed.current.splice(0)) ready();
  });
  const [arrived] = useState(() => () => {
    arrival.current = null;
    follow.current();
    setArriving(null);
  });
  follow.current = () => {
    const view = read();
    if (view) travel.current = travelAfter(travel.current, view);
    const now = Date.now();
    const step = view ? Math.abs(view.top - seen.current.top) : 0;
    if (view && step) seen.current = { top: view.top, at: now, runway: now - seen.current.at < 200 ? runwayScreens(step, now - seen.current.at, view.bottom - view.top) : 0 };
    else if (now - seen.current.at >= 200) seen.current.runway = 0;
    if (view && !aside && holdsForArrival(view, placed.current, arrival.current, step)) return;
    if (aside && current && (step || dragged || arrival.current)) setAside(false);
    const next = aside && view ? asideBand(view) : nextWindow(placed.current, view, firstPaint, !!dragged, travel.current.up, seen.current.runway);
    if (next.top === placed.current.top && next.bottom === placed.current.bottom) return;
    placed.current = next;
    setBand(next);
  };
  useEffect(() => {
    if (!current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expect = (tabId: string) => {
      clearTimeout(timer);
      setArriving(tabId);
      timer = setTimeout(arrived, ARRIVAL_MS);
    };
    const stop = watchRevealTargets(windowId, (switched, opened) => {
      const tabId = switched ?? opened;
      if (tabId) expect(tabId);
    });
    const withdraw = offerLanding(windowId, (tabId, ready) => {
      expect(tabId);
      landed.current.push(ready);
      settle();
      return true;
    });
    return () => {
      stop();
      withdraw();
      clearTimeout(timer);
      arrived();
    };
  }, [windowId, current]);

  useEffect(() => {
    if (!viewport) return;
    follow.current();
    return viewport.watch(() => follow.current());
  }, [viewport, aside, !!dragged, arriving]);

  const held = useRef(new Map<string, number>()).current;
  useEffect(() => {
    if (!held.size) return;
    const timer = setTimeout(settle, Math.max(0, Math.min(...held.values()) - Date.now()) + 1);
    return () => clearTimeout(timer);
  });

  if (reader) {
    shown.current = null;
    held.clear();
    return null;
  }
  const now = Date.now();
  const was = shown.current;
  if (was && was.geometry !== geometry) for (const key of was.window.mounted) if (!held.has(key)) held.set(key, now + LAYOUT_SETTLE_MS);
  const keys = [...(hovered ? [entryKey("tab", hovered)] : []), ...(renaming ? [renaming] : []), ...(dragged ? dragged.split("\n") : NO_TABS)];
  const kept = new Set(keptEntryIndices(list, index, tabs ? tabs.split("\n") : NO_TABS, keys));
  for (const key of moving()) if (index.has(key)) kept.add(index.get(key)!);
  for (const [key, until] of held) {
    if (until <= now || !index.has(key)) held.delete(key);
    else kept.add(index.get(key)!);
  }
  const view = arriving ? read() : null;
  const target = arriving ? keptEntryIndices(list, index, [arriving], NO_TABS)[0]! : -1;
  if (!arriving || target < 0) side.current = null;
  else if (side.current?.tabId !== arriving) side.current = { tabId: arriving, side: arrivalSide(geometry, target, view) };
  arrival.current = view && side.current ? arrivalBand(geometry, target, view.bottom - view.top, side.current.side) : null;
  const mounted = mountedIndices(geometry, [band, arrival.current], kept);
  if (was && was.geometry === geometry && sameIndices(was.indices, mounted)) return was.window;
  const { pieces, after } = windowPieces(geometry, rowGap, mounted);
  const before = new Map<string, number>();
  for (const p of pieces) if (p.before > 0) before.set(list[p.index]!, p.before);
  const next = { mounted: pieces.map((p) => list[p.index]!), before, after, geometry };
  shown.current = { geometry, indices: mounted, window: next };
  if (current) noteSidebarRowsMounted(next.mounted.length);
  return next;
}

const sameIndices = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

function asideBand(view: ListBand): ListBand {
  const screen = view.bottom - view.top;
  return { top: view.top - screen * ASIDE_AHEAD.above, bottom: view.bottom + screen * ASIDE_AHEAD.below };
}
