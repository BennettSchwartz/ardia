import { openStoreTransaction, useBrowser, type BrowserState } from "../browser/store";
import { folderPlace } from "../sharedFolders/engine";
import { knownNames, localFolder, signatureOf } from "../sharedFolders/local";
import { boundFolders, folderRef } from "../sharedFolders/store";
import { SHARED_GROUPS_SIDEBAR_ONLY } from "./workspaceSharedGuard";

export const SHARED_GROUP_CHANGE_REFUSED = `That would change a group synced to a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}. The change that reached it was undone.`;

function syncedProjection(s: BrowserState): Map<string, string> {
  const out = new Map<string, string>();
  for (const { profileId, key, folder } of boundFolders()) {
    const place = folderPlace(s, profileId, key);
    out.set(folderRef(profileId, key), place.kind === "shown" ? `shown:${signatureOf(localFolder(s, place.groupId, knownNames(folder.base)))}` : place.kind);
  }
  return out;
}

export function changesSharedFolders(before: BrowserState, after: BrowserState): boolean {
  if (before === after) return false;
  const was = syncedProjection(before);
  const now = syncedProjection(after);
  for (const [ref, then] of was) {
    const current = now.get(ref) ?? "gone";
    if (then === current || then === "gone") continue;
    if (current === "gone") return true;
    if (then.startsWith("shown:") && current.startsWith("shown:")) return true;
  }
  return false;
}

type Segment = { owner: SocketOrigin; before: BrowserState; close: () => void };

let open: Segment | null = null;

function endSegment(owner?: SocketOrigin) {
  const segment = open;
  if (!segment || (owner && segment.owner !== owner)) return;
  open = null;
  try {
    if (changesSharedFolders(segment.before, useBrowser.getState())) {
      useBrowser.setState(segment.before, true);
      segment.owner.vetoed = true;
    }
  } finally {
    segment.close();
  }
}

export class SocketOrigin {
  vetoed = false;

  segment() {
    if (open) return;
    open = { owner: this, before: useBrowser.getState(), close: openStoreTransaction() };
    queueMicrotask(() => endSegment(this));
  }

  settle<B>(body: B, refused: (message: string) => B): B {
    endSegment(this);
    return this.vetoed ? refused(SHARED_GROUP_CHANGE_REFUSED) : body;
  }
}

export function guardedBySocketOrigin<B>(run: (origin: SocketOrigin) => B | Promise<B>, refused: (message: string) => B): B | Promise<B> {
  const origin = new SocketOrigin();
  origin.segment();
  let body: B | Promise<B>;
  try {
    body = run(origin);
  } catch (error) {
    endSegment(origin);
    throw error;
  }
  if (body instanceof Promise) return body.then((settled) => origin.settle(settled, refused), (error) => (endSegment(origin), Promise.reject(error)));
  return origin.settle(body, refused);
}
