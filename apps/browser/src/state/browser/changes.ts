const NONE: readonly string[] = [];
const memo = new WeakMap<object, { prev: object; ids: readonly string[] }>();
const keyLists = new WeakMap<object, readonly string[]>();

export function keysOf(o: object): readonly string[] {
  let keys = keyLists.get(o);
  if (!keys) keyLists.set(o, (keys = Object.keys(o)));
  return keys;
}

export function changedIds<T>(next: Record<string, T>, prev: Record<string, T>): readonly string[] {
  if (next === prev) return NONE;
  const hit = memo.get(next);
  if (hit?.prev === prev) return hit.ids;
  const ids: string[] = [];
  const keys = keysOf(next);
  let added = 0;
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i]!;
    const before = prev[id];
    if (next[id] === before) continue;
    ids.push(id);
    if (before === undefined) added++;
  }
  const before = keysOf(prev);
  if (before.length > keys.length - added) for (const id of before) if (next[id] === undefined) ids.push(id);
  memo.set(next, { prev, ids });
  return ids;
}
