import { createSharedFolder, sharedFoldersAvailable, sharedLocation } from "../../platform/sharedFolders";
import { useBrowser } from "../browser/store";
import { isIncognitoProfile, pinKeyOf } from "../browser/model";
import type { TabGroup } from "../browser/types";
import { groupLabel } from "../pins/tabGrouping";
import { fileUrlOf, stopSyncingGroup, withSharedGroup } from "../sharedFolders/actions";
import { syncFolderAfterNow, syncFolderNow } from "../sharedFolders/engine";
import { canShareGroup, sharedFolderOfGroup } from "../sharedFolders/removal";
import { bindFolder, boundFolders, folderRef, sharedFolderOf, useSharedFolders, type SharedFolder } from "../sharedFolders/store";
import type { BaseEntry } from "../sharedFolders/tree";
import { eligibleKind, ownEntry } from "./automationWindows";
import type { MethodSpec } from "./socketCatalog";
import { id, obj, text, WINDOW } from "./socketSchema";
import { expect, now, windowOrFocused } from "./socketTargets";
import { OpError } from "./workspaceTargets";

const linkCount = (base: BaseEntry[]): number => base.reduce((n, b) => n + (b.kind === "link" ? 1 : linkCount(b.children)), 0);

function groupsFor(profileId: string, key: string): TabGroup[] {
  const s = now();
  return Object.values(s.groups).filter((g) => g.profileId === profileId && g.pinned && !g.parentId && pinKeyOf(g) === key && eligibleKind(s, g.windowId) === "normal");
}

function row(profileId: string, key: string, folder: SharedFolder) {
  const groups = groupsFor(profileId, key);
  const sync = useSharedFolders.getState().sync[folderRef(profileId, key)];
  return {
    profile: profileId,
    key,
    groups: groups.map((g) => g.id),
    name: groups[0] ? groupLabel(now(), groups[0]) : (folder.path.split("/").filter(Boolean).at(-1) ?? ""),
    path: folder.path,
    url: fileUrlOf(folder.path),
    links: linkCount(folder.base),
    state: sync?.state ?? "waiting",
    waiting: sync?.waiting ?? 0,
    error: sync?.error ?? null,
    addedAt: folder.addedAt,
  };
}

function available() {
  if (!sharedFoldersAvailable()) throw new OpError("refused", "Shared folders aren't available in this Ardia.");
}

function groupOf(groupId: unknown): TabGroup {
  const s = now();
  const g = ownEntry(s.groups, groupId);
  if (!g || eligibleKind(s, g.windowId) !== "normal" || isIncognitoProfile(g.profileId)) throw new OpError("no_window", `There's no group ${String(groupId)} the ardia command can use.`);
  return g;
}

const isPath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.split("/").includes("..");

function list() {
  return boundFolders()
    .filter(({ profileId }) => !isIncognitoProfile(profileId) && !!now().profiles[profileId])
    .map(({ profileId, key, folder }) => row(profileId, key, folder));
}

async function share(params: Record<string, unknown>) {
  available();
  const g = groupOf(params.group);
  if (!canShareGroup(now(), g.id)) throw new OpError("bad_request", "Only a pinned folder at the top of the sidebar can be shared.");
  const key = pinKeyOf(g);
  if (!sharedFolderOf(g.profileId, key)) {
    if (params.parent !== undefined && !isPath(params.parent)) throw new OpError("bad_request", "parent is an absolute folder path.");
    const location = sharedLocation();
    const parent = (params.parent as string | undefined) ?? (location.iCloudAvailable ? location.path : null);
    if (!parent) throw new OpError("refused", "iCloud Drive is off; pass parent, a folder that syncs some other way.");
    const path = await createSharedFolder(parent, groupLabel(now(), g) || "Shared Folder");
    bindFolder(g.profileId, key, path);
  }
  await syncFolderAfterNow(g.profileId, key);
  const folder = sharedFolderOf(g.profileId, key);
  expect(!!folder, "the folder isn't shared.");
  return row(g.profileId, key, folder!);
}

async function add(params: Record<string, unknown>) {
  available();
  if (!isPath(params.path)) throw new OpError("bad_request", "path is an absolute folder path.");
  const path = (params.path as string).replace(/\/+$/, "");
  const w = windowOrFocused(params.window);
  const profileId = w.profileId;
  const known = boundFolders().find((b) => b.profileId === profileId && b.folder.path === path);
  if (known) {
    await syncFolderNow(profileId, known.key);
    return row(profileId, known.key, sharedFolderOf(profileId, known.key)!);
  }
  const [next, groupId] = withSharedGroup(now(), w.id, path.split("/").filter(Boolean).at(-1) ?? "Shared Folder");
  expect(!!groupId, "the folder's group wasn't made.");
  useBrowser.setState(next);
  const key = pinKeyOf(now().groups[groupId]!);
  bindFolder(profileId, key, path);
  await syncFolderNow(profileId, key);
  return row(profileId, key, sharedFolderOf(profileId, key)!);
}

function sharedOf(groupId: unknown) {
  const g = groupOf(groupId);
  const shared = sharedFolderOfGroup(now(), g.id);
  if (!shared) throw new OpError("bad_request", `Group ${g.id} isn't a shared folder.`);
  return shared;
}

async function syncNow(params: Record<string, unknown>) {
  const { profileId, key } = sharedOf(params.group);
  await syncFolderNow(profileId, key);
  return row(profileId, key, sharedFolderOf(profileId, key)!);
}

function stop(params: Record<string, unknown>) {
  const { profileId, key } = sharedOf(params.group);
  stopSyncingGroup(params.group as string);
  expect(!sharedFolderOf(profileId, key), "the folder still syncs.");
  return { ok: true };
}

const GROUP = id("A pinned folder's group id from workspace or sharedFolders.list");
const ROW = "{profile, key, groups, name, path, url, links, state, waiting, error, addedAt}";

export const SHARED_FOLDER_METHODS: MethodSpec[] = [
  { name: "sharedFolders.list", mutates: false, description: "Sidebar folders backed by a folder on disk (shared through iCloud Drive or another synced folder), with their sync state", params: obj({}), result: `[${ROW}]`, run: list },
  {
    name: "sharedFolders.share",
    mutates: true,
    description: "Back a pinned folder with a folder on disk others can be invited to; its file URL is in the reply",
    params: obj({ group: GROUP, parent: text("The folder to make it in; iCloud Drive's Ardia folder when left out") }, ["group"]),
    result: ROW,
    run: share,
  },
  {
    name: "sharedFolders.add",
    mutates: true,
    description: "Add a folder on disk someone shared as a pinned folder in a window's profile",
    params: obj({ path: text("The folder's absolute path"), window: { ...WINDOW, description: "A window id from windows; the focused one when left out" } }, ["path"]),
    result: ROW,
    run: add,
  },
  { name: "sharedFolders.sync", mutates: true, description: "Sync a shared folder with its files now", params: obj({ group: GROUP }, ["group"]), result: ROW, run: syncNow },
  { name: "sharedFolders.stop", mutates: true, description: "Stop syncing a folder; the group and the files on disk stay", params: obj({ group: GROUP }, ["group"]), result: "{ok}", run: stop },
];
