export type HistoryPage = { url: string; profileId: string; engine: string };

const MAX_HANDLES = 20_000;
const tables = new Map<number, { byId: Map<string, HistoryPage>; byPage: Map<string, string> }>();

const pageKey = (page: HistoryPage) => `${page.profileId}\n${page.engine}\n${page.url}`;

function randomHandle(taken: Map<string, HistoryPage>): string {
  for (;;) {
    let id = "h";
    for (let i = 0; i < 4; i++) id += Math.floor(Math.random() * 0x100000000).toString(36).padStart(7, "0");
    if (!taken.has(id)) return id;
  }
}

export function historyHandle(connection: number, page: HistoryPage): string {
  let table = tables.get(connection);
  if (!table) tables.set(connection, (table = { byId: new Map(), byPage: new Map() }));
  const key = pageKey(page);
  const known = table.byPage.get(key);
  if (known) return known;
  const id = randomHandle(table.byId);
  table.byId.set(id, page);
  table.byPage.set(key, id);
  while (table.byId.size > MAX_HANDLES) {
    const [oldest, stale] = table.byId.entries().next().value!;
    table.byId.delete(oldest);
    table.byPage.delete(pageKey(stale));
  }
  return id;
}

export const historyPageOf = (connection: number, id: string): HistoryPage | undefined => tables.get(connection)?.byId.get(id);

export const dropHistoryHandles = (connection: number) => void tables.delete(connection);

export const dropAllHistoryHandles = () => tables.clear();
