const PREFIX = "h1";
const TOKEN = /^h1\.([0-9a-f]{16})\.([0-9a-z]{1,11})$/;

function hash32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

export function urlDigest(url: string): string {
  const hex = (n: number) => n.toString(16).padStart(8, "0");
  return hex(hash32(url, 0x811c9dc5)) + hex(hash32(url, 0x9747b28c));
}

export const historyRowId = (url: string, lastVisit: number): string => `${PREFIX}.${urlDigest(url)}.${Math.max(0, Math.floor(lastVisit)).toString(36)}`;

export type HistoryKey = { digest: string; lastVisit: number };

export function parseHistoryKey(id: string): HistoryKey | null {
  const match = TOKEN.exec(id);
  if (!match) return null;
  const lastVisit = parseInt(match[2]!, 36);
  return Number.isSafeInteger(lastVisit) ? { digest: match[1]!, lastVisit } : null;
}
