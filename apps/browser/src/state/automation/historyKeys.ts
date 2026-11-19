export const MAX_HISTORY_KEYS = 20_000;

type Page = { engine: string; url: string };

const byPage = new Map<string, string>();
const byId = new Map<string, Page>();
let issued = 0;

const pageKey = (engine: string, url: string) => `${engine}\n${url}`;

export function historyRowId(engine: string, url: string): string {
  const key = pageKey(engine, url);
  const known = byPage.get(key);
  const id = known ?? `h${(++issued).toString(36)}`;
  byPage.delete(key);
  byId.delete(id);
  byPage.set(key, id);
  byId.set(id, { engine, url });
  while (byId.size > MAX_HISTORY_KEYS) {
    const [oldest, page] = byId.entries().next().value!;
    byId.delete(oldest);
    byPage.delete(pageKey(page.engine, page.url));
  }
  return id;
}

export const historyPageOf = (id: string): Page | undefined => byId.get(id);
