export type Mark = [kind: string, at: number];

export const NATIVE_REVEAL_COUNTS: Record<string, string> = { nativeReveal: "j3_native", nativeRevealDropped: "j3_native_dropped", nativeRevealFocus: "j3_native_focus" };

const NATIVE_PRESS_MAX_AGE = 30_000;

export function nativePressTime(marks: Map<string, Mark[]>, key: string, now: number): number | null {
  const list = marks.get(key);
  if (!list) return null;
  let at: number | null = null;
  for (const [kind, when] of list) if (kind === "nativePress" && now - when <= NATIVE_PRESS_MAX_AGE && (at === null || when > at)) at = when;
  if (at !== null) marks.set(key, list.filter(([kind]) => kind !== "nativePress"));
  return at;
}
