import { discardSharedFolder, readSharedFolder, resolveSharedFolder, type ResolvedSharedFolder } from "../../platform/sharedFolders";
import { errorText } from "../../lib/errors";
import { boundFolders } from "../sharedFolders/store";
import { OpError } from "./workspaceTargets";

const SYSTEM_ROOTS = ["/", "/System", "/Library", "/Applications", "/Users", "/Volumes", "/bin", "/sbin", "/usr", "/etc", "/var", "/tmp", "/dev", "/opt", "/cores", "/private", "/private/etc", "/private/var", "/private/tmp", "/Network"];

export const isAbsolutePath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !path.split("/").includes("..");

const homeOf = (path: string) => /^\/Users\/[^/]+$/.test(path);

export async function canonicalFolder(path: string, what: string): Promise<ResolvedSharedFolder> {
  let found: ResolvedSharedFolder;
  try {
    found = await resolveSharedFolder(path);
  } catch (error) {
    throw new OpError("bad_request", `${what}: ${errorText(error)}`);
  }
  const trimmed = found.path.replace(/\/+$/, "") || "/";
  if (SYSTEM_ROOTS.includes(trimmed) || homeOf(trimmed)) throw new OpError("refused", `${what}: ${trimmed} is a system or home folder; pick a folder inside it.`);
  return { ...found, path: trimmed };
}

export async function readableFolder(found: ResolvedSharedFolder) {
  const listing = await readSharedFolder(found.path, { device: found.device, inode: found.inode });
  if (!listing.exists) throw new OpError("bad_request", listing.error ?? `There's no folder at ${found.path}.`);
  if (listing.root.error) throw new OpError("bad_request", listing.root.error);
}

export function bindingAt(profileId: string, found: ResolvedSharedFolder) {
  return boundFolders().find(
    (b) => b.profileId === profileId && (b.folder.path === found.path || (b.folder.identity?.device === found.device && b.folder.identity?.inode === found.inode)),
  );
}

export const discardFolder = (path: string) => discardSharedFolder(path).catch(() => undefined);

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
