import type { ListBand } from "./listViewport";

export type ListGeometry = { tops: number[]; heights: number[]; end: number };
export type WindowPiece = { index: number; before: number };

type Reach = { above: number; below: number };
export type Travel = { up: boolean; turn: number };

export const WINDOW_AHEAD: Reach = { above: 1, below: 2 };
export const WINDOW_NEED: Reach = { above: 0.5, below: 1 };
export const DRAG_AHEAD: Reach = { above: 3, below: 3 };
export const DRAG_NEED: Reach = { above: 2, below: 2 };
export const TURN_SCREENS = 0.25;
export const RUNWAY = { seconds: 0.15, mostScreens: 4, spareScreens: 1 } as const;

export function runwayScreens(distance: number, ms: number, screen: number): number {
  if (screen <= 0 || ms <= 0) return 0;
  return Math.min(RUNWAY.mostScreens, ((Math.abs(distance) / ms) * 1000 * RUNWAY.seconds) / screen);
}
export const ARRIVAL_REACH = { approach: 2.25, beyond: 0.25 } as const;

const flipped = (reach: Reach, up: boolean): Reach => (up ? { above: reach.below, below: reach.above } : reach);

export function travelAfter(was: Travel, view: ListBand): Travel {
  const far = (view.bottom - view.top) * TURN_SCREENS;
  if (was.up) return view.top > was.turn + far ? { up: false, turn: view.top } : { up: true, turn: Math.min(was.turn, view.top) };
  return view.top < was.turn - far ? { up: true, turn: view.top } : { up: false, turn: Math.max(was.turn, view.top) };
}

export function arrivalSide(g: ListGeometry, index: number, view: ListBand | null): -1 | 0 | 1 {
  if (!view || index < 0 || index >= g.tops.length) return 0;
  if (g.tops[index]! + g.heights[index]! <= view.top) return -1;
  return g.tops[index]! >= view.bottom ? 1 : 0;
}

export function arrivalBand(g: ListGeometry, index: number, screen: number, side: -1 | 0 | 1): ListBand | null {
  if (index < 0 || index >= g.tops.length || screen <= 0 || !side) return null;
  const top = g.tops[index]!;
  const bottom = top + g.heights[index]!;
  const { approach, beyond } = ARRIVAL_REACH;
  return side > 0 ? { top: top - screen * approach, bottom: bottom + screen * beyond } : { top: top - screen * beyond, bottom: bottom + screen * approach };
}

export function listGeometry(heights: number[], gap: number): ListGeometry {
  const tops = new Array<number>(heights.length);
  let y = 0;
  for (let i = 0; i < heights.length; i++) {
    tops[i] = y;
    y += heights[i]! + gap;
  }
  return { tops, heights, end: heights.length ? y - gap : 0 };
}

export function bandAround(view: ListBand, ahead: Reach): ListBand {
  const screen = Math.max(0, view.bottom - view.top);
  return { top: view.top - screen * ahead.above, bottom: view.bottom + screen * ahead.below };
}

export const covers = (outer: ListBand, inner: ListBand) => outer.top <= inner.top && outer.bottom >= inner.bottom;

export function nextWindow(current: ListBand | null, view: ListBand | null, firstPaint: number, dragging = false, up = false, runway = 0): ListBand {
  if (!view || view.bottom <= view.top) return current ?? { top: 0, bottom: firstPaint };
  const need = dragging ? DRAG_NEED : { above: WINDOW_NEED.above, below: Math.max(WINDOW_NEED.below, runway) };
  const ahead = dragging ? DRAG_AHEAD : { above: WINDOW_AHEAD.above, below: Math.max(WINDOW_AHEAD.below, runway + RUNWAY.spareScreens) };
  if (current && covers(current, bandAround(view, dragging ? need : flipped(need, up)))) return current;
  return bandAround(view, dragging ? ahead : flipped(ahead, up));
}

function firstEndingBelow(g: ListGeometry, y: number): number {
  let lo = 0;
  let hi = g.tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.tops[mid]! + g.heights[mid]! > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function firstStartingAt(g: ListGeometry, y: number): number {
  let lo = 0;
  let hi = g.tops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.tops[mid]! >= y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function entriesIn(g: ListGeometry, band: ListBand): [number, number] {
  const first = firstEndingBelow(g, band.top);
  return [first, Math.max(first, firstStartingAt(g, band.bottom))];
}

export function mountedIndices(g: ListGeometry, bands: ListBand | (ListBand | null)[], kept: Iterable<number>): number[] {
  const out = new Set<number>();
  for (const band of Array.isArray(bands) ? bands : [bands]) {
    if (!band) continue;
    const [first, last] = entriesIn(g, band);
    for (let i = first; i < last; i++) out.add(i);
  }
  for (const i of kept) if (i >= 0 && i < g.tops.length) out.add(i);
  return [...out].sort((a, b) => a - b);
}

export function windowPieces(g: ListGeometry, gap: number, mounted: number[]): { pieces: WindowPiece[]; after: number } {
  const pieces: WindowPiece[] = [];
  let prev = -1;
  for (const index of mounted) {
    const before = prev < 0 ? (index > 0 ? g.tops[index]! - gap : 0) : index > prev + 1 ? g.tops[index]! - (g.tops[prev]! + g.heights[prev]!) - 2 * gap : 0;
    pieces.push({ index, before });
    prev = index;
  }
  const n = g.tops.length;
  if (!n) return { pieces, after: 0 };
  if (prev < 0) return { pieces, after: g.end };
  return { pieces, after: prev < n - 1 ? g.end - (g.tops[prev]! + g.heights[prev]!) - gap : 0 };
}

export function keepSlots(keys: string[], previous: Map<string, number>): Map<string, number> {
  const placeOf = new Map<number, number>();
  for (const slot of previous.values()) placeOf.set(slot, placeOf.size);
  const kept = new Set(keys.filter((key) => previous.has(key)).map((key) => previous.get(key)!));
  const freed = [...previous.values()].filter((slot) => !kept.has(slot));
  const before = new Array<number>(keys.length);
  let limit = Infinity;
  for (let i = keys.length - 1; i >= 0; i--) {
    before[i] = limit;
    const slot = previous.get(keys[i]!);
    if (slot !== undefined) limit = Math.min(limit, placeOf.get(slot)!);
  }
  const next = new Map<string, number>();
  let reuse = 0;
  let fresh = 0;
  keys.forEach((key, i) => {
    const own = previous.get(key);
    if (own !== undefined) return void next.set(key, own);
    if (reuse < freed.length && placeOf.get(freed[reuse]!)! < before[i]!) return void next.set(key, freed[reuse++]!);
    while (placeOf.has(fresh)) fresh++;
    placeOf.set(fresh, -1);
    next.set(key, fresh);
  });
  return next;
}

export const GLIDE_STEP_SCREENS = 0.2;

export function holdsForArrival(view: ListBand, band: ListBand, arrival: ListBand | null, step: number): boolean {
  if (!arrival) return false;
  if (covers(arrival, view) || covers(band, view)) return true;
  if (step < (view.bottom - view.top) * GLIDE_STEP_SCREENS) return false;
  const below = arrival.top >= band.top;
  return below ? view.top >= band.top && view.top < arrival.top : view.bottom <= band.bottom && view.bottom > arrival.bottom;
}
