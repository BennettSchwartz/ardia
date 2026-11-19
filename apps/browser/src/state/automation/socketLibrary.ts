import type { BookmarkNode } from "../browser/types";
import { engineProfile } from "../browser/model";
import { bookmarkRoots, folderChildren, isWithin, ownerOfBookmark } from "../bookmarks/bookmarks";
import { pruneEngineFavicons, cacheKey } from "../favicons/favicons";
import { historyOf, historyViewOf } from "../history/history";
import { clearBrowsingData } from "../profiles/profileData";
import { queryHistory } from "../../platform/history";
import type { MethodSpec } from "./socketCatalog";
import { id, ids, int, obj, PAGE, PROFILE, text } from "./socketSchema";
import { expect, now, page, profileArg } from "./socketTargets";
import { openableUrl } from "./workspaceOps";
import { OpError } from "./workspaceTargets";

const MAX_DEPTH = 64;

function bookmarkRow(node: BookmarkNode, depth: number): Record<string, unknown> {
  const b = now().bookmarks;
  const base = { id: node.id, kind: node.kind, parent: node.parentId, title: node.title, addedAt: node.addedAt };
  if (node.kind === "url") return { ...base, url: node.url };
  return { ...base, children: depth > 0 ? folderChildren(b, node.id).map((c) => bookmarkRow(c, depth - 1)) : node.children.length };
}

function rootsOf(profile: string) {
  const roots = bookmarkRoots(now(), profile);
  if (!roots) throw new OpError("failed", `Profile ${profile}'s bookmarks haven't loaded yet; open a window in it first.`);
  return roots;
}

function nodeOf(value: unknown): BookmarkNode {
  const s = now();
  const node = typeof value === "string" && Object.hasOwn(s.bookmarks.nodes, value) ? s.bookmarks.nodes[value] : undefined;
  if (!node || !ownerOfBookmark(s, node.id)) throw new OpError("no_window", `There's no bookmark ${String(value)}.`);
  return node;
}

function folderOf(value: unknown) {
  const node = nodeOf(value);
  if (node.kind !== "folder") throw new OpError("bad_request", `${node.id} is a link, not a folder.`);
  return node;
}

function tree(params: Record<string, unknown>) {
  const depth = (params.depth as number | undefined) ?? MAX_DEPTH;
  if (params.folder !== undefined) return bookmarkRow(folderOf(params.folder), depth);
  const roots = rootsOf(profileArg(params.profile));
  const b = now().bookmarks;
  return { bar: bookmarkRow(b.nodes[roots.bar]!, depth), other: bookmarkRow(b.nodes[roots.other]!, depth) };
}

function search(params: Record<string, unknown>) {
  const roots = rootsOf(profileArg(params.profile));
  const b = now().bookmarks;
  const q = ((params.query as string | undefined) ?? "").toLowerCase();
  const hits = Object.values(b.nodes).filter(
    (n) => n.id !== roots.bar && n.id !== roots.other && isWithin(b, n.id, [roots.bar, roots.other]) && (!q || n.title.toLowerCase().includes(q) || (n.kind === "url" && n.url.toLowerCase().includes(q))),
  );
  return page(hits.sort((x, y) => y.addedAt - x.addedAt).map((n) => bookmarkRow(n, 0)), params);
}

function placeOf(params: Record<string, unknown>) {
  if (params.parent === undefined) return { profileId: profileArg(params.profile), parentId: undefined };
  const parent = folderOf(params.parent);
  return { profileId: ownerOfBookmark(now(), parent.id)!, parentId: parent.id };
}

function linkUrl(value: unknown): string {
  const url = openableUrl(value as string);
  if (typeof url !== "string" || !url) throw new OpError("refused", typeof url === "string" ? "A bookmark needs a page." : url.error);
  return url;
}

function add(params: Record<string, unknown>) {
  const { profileId, parentId } = placeOf(params);
  const url = linkUrl(params.url);
  const made = now().addBookmark({ profileId, url, title: (params.title as string | undefined) ?? url, parentId, index: params.index as number | undefined });
  expect(!!now().bookmarks.nodes[made], "the bookmark wasn't added.");
  return bookmarkRow(now().bookmarks.nodes[made]!, 0);
}

function addFolder(params: Record<string, unknown>) {
  const { profileId, parentId } = placeOf(params);
  const made = now().addBookmarkFolder({ profileId, title: params.title as string, parentId, index: params.index as number | undefined });
  expect(!!now().bookmarks.nodes[made], "the folder wasn't added.");
  return bookmarkRow(now().bookmarks.nodes[made]!, 0);
}

function update(params: Record<string, unknown>) {
  const node = nodeOf(params.id);
  if (params.url !== undefined && node.kind !== "url") throw new OpError("bad_request", "A folder has no URL.");
  if (params.title === undefined && params.url === undefined) throw new OpError("bad_request", "bookmarks.update needs title or url.");
  now().updateBookmark(node.id, { ...(params.title !== undefined ? { title: params.title as string } : {}), ...(params.url !== undefined ? { url: linkUrl(params.url) } : {}) });
  return bookmarkRow(now().bookmarks.nodes[node.id]!, 0);
}

function move(params: Record<string, unknown>) {
  const parent = folderOf(params.parent);
  const owner = ownerOfBookmark(now(), parent.id);
  const nodes = (params.ids as string[]).map(nodeOf);
  for (const n of nodes) {
    if (ownerOfBookmark(now(), n.id) !== owner) throw new OpError("bad_request", `${n.id} is in another profile's bookmarks.`);
    if (n.kind === "folder" && (n.id === parent.id || isWithin(now().bookmarks, parent.id, [n.id]))) throw new OpError("bad_request", `${n.id} can't go inside itself.`);
    if (n.parentId === null) throw new OpError("refused", `${n.id} is a root folder.`);
  }
  now().moveBookmarks(nodes.map((n) => n.id), parent.id, params.index as number | undefined);
  expect(nodes.every((n) => now().bookmarks.nodes[n.id]?.parentId === parent.id), "the bookmarks didn't move.");
  return bookmarkRow(now().bookmarks.nodes[parent.id]!, 1);
}

function remove(params: Record<string, unknown>) {
  const nodes = (params.ids as string[]).map(nodeOf);
  const root = nodes.find((n) => n.parentId === null);
  if (root) throw new OpError("refused", `${root.id} is a root folder.`);
  now().removeBookmarks(nodes.map((n) => n.id));
  expect(nodes.every((n) => !now().bookmarks.nodes[n.id]), "the bookmarks weren't removed.");
  return { removed: nodes.length };
}

async function historySearch(params: Record<string, unknown>) {
  const profileId = profileArg(params.profile);
  const view = historyViewOf(now(), profileId);
  const list = view?.ready ? historyOf(now(), profileId) : (await queryHistory(engineProfile(now(), profileId), 100_000)).map((e) => ({ ...e, lastVisit: Math.max(0, ...(e.visitTimes ?? [])) }));
  const q = ((params.query as string | undefined) ?? "").toLowerCase();
  const since = (params.since as number | undefined) ?? -Infinity;
  const until = (params.until as number | undefined) ?? Infinity;
  const hits = list.filter((h) => h.lastVisit >= since && h.lastVisit <= until && (!q || h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q)));
  return page([...hits].sort((a, b) => b.lastVisit - a.lastVisit).map((h) => ({ url: h.url, title: h.title, visits: h.visits, lastVisit: h.lastVisit })), params);
}

async function historyClear(params: Record<string, unknown>) {
  const profileId = profileArg(params.profile);
  const engine = engineProfile(now(), profileId);
  const startedAt = Date.now();
  const since = params.since as number | undefined;
  await clearBrowsingData(engine, ["history"], since);
  if (engineProfile(now(), profileId) === engine) now().clearHistory(profileId, since, startedAt);
  pruneEngineFavicons(cacheKey(profileId));
  return { ok: true };
}

const BOOKMARK_PLACE = { profile: PROFILE, parent: id("A folder id; the profile's Bookmarks Bar when left out"), index: int("Position in the folder; the end when left out", 0) };
const SINCE = int("Milliseconds since 1970", 0);

export const LIBRARY_METHODS: MethodSpec[] = [
  { name: "bookmarks.tree", mutates: false, description: "A profile's Bookmarks Bar and Other Bookmarks, or one folder, as a tree", params: obj({ profile: PROFILE, folder: id("Only this folder"), depth: int("How many folder levels to open (all when left out)", 0, MAX_DEPTH) }), result: "{bar, other} | folder", run: tree },
  { name: "bookmarks.search", mutates: false, description: "Bookmarks and folders whose title or URL contains the query, newest first", params: obj({ profile: PROFILE, query: text("Text to look for; every bookmark when left out"), ...PAGE }), result: "{items, total, nextOffset}", run: search },
  { name: "bookmarks.get", mutates: false, description: "One bookmark or folder", params: obj({ id: id("A bookmark id") }, ["id"]), result: "bookmark", run: (p) => bookmarkRow(nodeOf(p.id), 1) },
  { name: "bookmarks.add", mutates: true, description: "Bookmark a page", params: obj({ url: text("The page"), title: text("Its title; the URL when left out"), ...BOOKMARK_PLACE }, ["url"]), result: "bookmark", run: add },
  { name: "bookmarks.addFolder", mutates: true, description: "Make a bookmarks folder", params: obj({ title: text("Its name"), ...BOOKMARK_PLACE }, ["title"]), result: "folder", run: addFolder },
  { name: "bookmarks.update", mutates: true, description: "Rename a bookmark or folder, or change a bookmark's URL", params: obj({ id: id("A bookmark id"), title: text("New title"), url: text("New URL") }, ["id"]), result: "bookmark", run: update },
  { name: "bookmarks.move", mutates: true, description: "Move bookmarks and folders into a folder", params: obj({ ids: ids("Bookmark ids, in the order they should land"), parent: id("The folder"), index: int("Position in the folder; the end when left out", 0) }, ["ids", "parent"]), result: "folder", run: move },
  { name: "bookmarks.remove", mutates: true, description: "Delete bookmarks and folders (with what's in them)", params: obj({ ids: ids("Bookmark ids") }, ["ids"]), result: "{removed}", run: remove },
  { name: "history.search", mutates: false, description: "Visited pages whose title or URL contains the query, newest first", params: obj({ profile: PROFILE, query: text("Text to look for"), since: SINCE, until: SINCE, ...PAGE }), result: "{items: [{url, title, visits, lastVisit}], total, nextOffset}", run: historySearch },
  {
    name: "history.remove",
    mutates: true,
    description: "Delete every visit to these pages",
    params: obj({ profile: PROFILE, urls: ids("Exact URLs as history.search gives them", 1000) }, ["urls"]),
    result: "{ok}",
    run: (p) => {
      now().removeHistory(profileArg(p.profile), p.urls as string[]);
      return { ok: true };
    },
  },
  { name: "history.clear", mutates: true, description: "Clear a profile's history, all of it or since a time, as Clear Browsing Data does", params: obj({ profile: PROFILE, since: SINCE }), result: "{ok}", run: historyClear },
];
