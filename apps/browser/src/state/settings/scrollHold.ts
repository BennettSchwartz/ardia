const HOLD_MS = 1500;

export type ScrollHold = { target: number; until: number };

export const startScrollHold = (target: number, now: number): ScrollHold | null => (target > 0 ? { target, until: now + HOLD_MS } : null);

export const holdTarget = (hold: ScrollHold | null, now: number) => (hold && now <= hold.until ? hold.target : null);

export function holdAfterScroll(hold: ScrollHold | null, y: number, end: number, now: number): ScrollHold | null {
  if (holdTarget(hold, now) === null) return null;
  const target = hold!.target;
  if (Math.abs(y - target) < 1) return null;
  const clampedAtBottom = end < target && Math.abs(y - Math.max(0, end)) < 1;
  return clampedAtBottom ? hold : null;
}
