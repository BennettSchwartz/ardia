import { resolveSharedFolder, type ResolvedSharedFolder, type SharedFolderIdentity } from "../../platform/sharedFolders";
import { boundFolders, sharedFolderOf, upgradeFolder, type SharedFolder } from "./store";

export async function upgradeLegacy(profileId: string, key: string): Promise<SharedFolder | undefined> {
  const was = sharedFolderOf(profileId, key);
  if (!was || was.identity) return was;
  const found = await resolveSharedFolder(was.path).catch(() => null);
  if (found) upgradeFolder(profileId, key, was, found);
  return sharedFolderOf(profileId, key);
}

const sameFolder = (folder: SharedFolder, found: ResolvedSharedFolder) =>
  folder.identity ? folder.identity.device === found.device && folder.identity.inode === found.inode : folder.path === found.path;

export async function bindingAt(profileId: string, found: ResolvedSharedFolder) {
  const legacy = boundFolders().filter((b) => b.profileId === profileId && !b.folder.identity);
  await Promise.all(legacy.map((b) => upgradeLegacy(profileId, b.key)));
  return boundFolders().find((b) => b.profileId === profileId && sameFolder(b.folder, found));
}

export const boundWithIdentity = (profileId: string, found: SharedFolderIdentity) =>
  boundFolders().find((b) => b.profileId === profileId && b.folder.identity?.device === found.device && b.folder.identity?.inode === found.inode);

export const addKey = (profileId: string, found: SharedFolderIdentity) => `${profileId}\u0001${found.device}:${found.inode}`;

const locks = new Map<string, Promise<unknown>>();

export function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(work);
  const held = mine.catch(() => undefined);
  locks.set(key, held);
  void held.then(() => {
    if (locks.get(key) === held) locks.delete(key);
  });
  return mine;
}
