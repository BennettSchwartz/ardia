import { engineProfile } from "../browser/model";
import { pruneEngineFavicons, cacheKey } from "../favicons/favicons";
import { historyOf, historyViewOf } from "../history/history";
import { clearBrowsingData } from "../profiles/profileData";
import { queryHistory } from "../../platform/history";
import { isWebPageUrl } from "../../lib/url";
import { historyRowId, parseHistoryKey, urlDigest } from "./historyKeys";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { ids, int, obj, PAGE, PROFILE, text } from "./socketSchema";
import { now, page, profileArg } from "./socketTargets";
import { CLIPPED_STRING_CHARS } from "./socketWire";
import { OpError } from "./workspaceTargets";

export const HISTORY_SCAN = 20_000;
export const MAX_RAW_HISTORY_ROWS = 1_000_000;

type Visited = { url: string; title: string; visits: number; lastVisit: number };
type Read = { rows: Visited[]; capped: boolean };

async function engineWebPages(engine: string, count: number): Promise<Read> {
  let asked = count;
  for (;;) {
    const read = await queryHistory(engine, asked, 1);
    const pages = read.filter((e) => isWebPageUrl(e.url));
    const ended = read.length < asked;
    if (pages.length >= count || ended || asked >= MAX_RAW_HISTORY_ROWS) {
      const rows = pages.slice(0, count).map((e) => ({ url: e.url, title: e.title, visits: e.visits, lastVisit: e.visitTimes[0] ?? 0 }));
      return { rows, capped: pages.length < count && !ended };
    }
    asked = Math.min(MAX_RAW_HISTORY_ROWS, asked * 2 + count - pages.length);
  }
}

async function newestPages(profileId: string, count: number): Promise<Read> {
  const view = historyViewOf(now(), profileId);
  const list = view?.ready ? historyOf(now(), profileId) : null;
  if (list && (list.length >= count || view!.floor === -Infinity)) {
    const rows = [...list].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, count);
    return { rows: rows.map((h) => ({ url: h.url, title: h.title, visits: h.visits, lastVisit: h.lastVisit })), capped: false };
  }
  return engineWebPages(engineProfile(now(), profileId), count);
}

async function historySearch(params: Record<string, unknown>) {
  const profileId = profileArg(params.profile);
  const q = ((params.query as string | undefined) ?? "").toLowerCase();
  const since = (params.since as number | undefined) ?? -Infinity;
  const until = (params.until as number | undefined) ?? Infinity;
  const filtered = !!q || params.since !== undefined || params.until !== undefined;
  const offset = (params.offset as number | undefined) ?? 0;
  const limit = (params.limit as number | undefined) ?? 100;
  const read = filtered ? HISTORY_SCAN + 1 : Math.min(offset + limit + 1, HISTORY_SCAN + 1);
  const { rows, capped } = await newestPages(profileId, read);
  const scanned = rows.slice(0, HISTORY_SCAN);
  const hits = filtered ? scanned.filter((h) => h.lastVisit >= since && h.lastVisit <= until && (!q || h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q))) : scanned;
  const shown = page(hits, params, (h) => ({ id: historyRowId(h.url, h.lastVisit), ...h }));
  const complete = rows.length < read && !capped;
  return { items: shown.items, total: complete ? hits.length : null, nextOffset: shown.nextOffset, truncated: capped || rows.length > HISTORY_SCAN };
}

async function currentRows(profileId: string): Promise<Visited[]> {
  const view = historyViewOf(now(), profileId);
  if (view?.ready && view.floor === -Infinity) return historyOf(now(), profileId);
  return (await engineWebPages(engineProfile(now(), profileId), MAX_RAW_HISTORY_ROWS)).rows;
}

async function pagesForIds(profileId: string, given: string[]): Promise<string[]> {
  const keys = given.map((id) => {
    const key = parseHistoryKey(id);
    if (!key) throw new OpError("bad_request", `${id} isn't a history id: pass ids as history.search gives them.`);
    return { id, key };
  });
  const byDigest = new Map<string, Visited>();
  for (const row of await currentRows(profileId)) byDigest.set(urlDigest(row.url), row);
  return keys.map(({ id, key }) => {
    const row = byDigest.get(key.digest);
    if (!row) throw new OpError("stale", `${id}'s page is no longer in this profile's history; search again.`);
    if (row.lastVisit > key.lastVisit) throw new OpError("stale", `${id}'s page was visited again since that search, so the id no longer names exactly what you saw; search again.`);
    return row.url;
  });
}

async function historyRemove(params: Record<string, unknown>, call: SocketCall) {
  const profileId = profileArg(params.profile);
  const given = params.ids as string[] | undefined;
  const urls = params.urls as string[] | undefined;
  if (!given === !urls) throw new OpError("bad_request", "history.remove takes ids (from history.search) or urls, one of the two.");
  if (urls?.some((url) => url.length >= CLIPPED_STRING_CHARS)) {
    throw new OpError("bad_request", `A URL of ${CLIPPED_STRING_CHARS} characters or more may be one history.search cut short, so it can't name a page; pass that row's id instead.`);
  }
  const gone = urls ?? (await pagesForIds(profileId, given!));
  call.stillServing();
  now().removeHistory(profileArg(params.profile), gone);
  return { ok: true };
}

async function historyClear(params: Record<string, unknown>, call: SocketCall) {
  const profileId = profileArg(params.profile);
  const engine = engineProfile(now(), profileId);
  const startedAt = Date.now();
  const since = params.since as number | undefined;
  await clearBrowsingData(engine, ["history"], since);
  if (call.serving() && engineProfile(now(), profileId) === engine) now().clearHistory(profileId, since, startedAt);
  pruneEngineFavicons(cacheKey(profileId));
  return { ok: true };
}

const SINCE = int("Milliseconds since 1970", 0);

export const HISTORY_METHODS: MethodSpec[] = [
  { name: "history.search", mutates: false, description: "Visited pages whose title or URL contains the query, newest first", params: obj({ profile: PROFILE, query: text("Text to look for"), since: SINCE, until: SINCE, ...PAGE }), result: "{items: [{id, url, title, visits, lastVisit, clipped?}], total, nextOffset, truncated}", run: historySearch },
  {
    name: "history.remove",
    mutates: true,
    description: "Delete every visit to these pages; an id visited again since its search answers stale",
    params: obj({ profile: PROFILE, ids: ids("Row ids from history.search", 1000), urls: ids("Exact URLs, none of them clipped (shorter than 32,768 characters)", 1000) }),
    result: "{ok}",
    run: historyRemove,
  },
  { name: "history.clear", mutates: true, description: "Clear a profile's history, all of it or since a time, as Clear Browsing Data does", params: obj({ profile: PROFILE, since: SINCE }), result: "{ok}", run: historyClear },
];
