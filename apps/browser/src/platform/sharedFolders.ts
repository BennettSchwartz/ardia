import { SharedFoldersNative, SyncNative, type SharedFolderIdentity, type SharedFolderOp } from "@ardia/sync";

export type { ResolvedSharedFolder, SharedFolderIdentity, SharedFolderOp, SharedListing, SharedListingEntry, SharedListingLevel, SharedLocation } from "@ardia/sync";

const Native = () => SharedFoldersNative!;

export const sharedFoldersAvailable = () => !!SharedFoldersNative;
export const sharedLocation = () => Native().location();
export const readSharedFolder = (path: string, identity: SharedFolderIdentity | null = null) => Native().read(path, identity);
export const writeSharedFolder = (path: string, ops: SharedFolderOp[], identity: SharedFolderIdentity | null = null) => Native().apply(path, JSON.stringify(ops), identity);
export const resolveSharedFolder = (path: string) => Native().resolve(path);
export const discardSharedFolder = (path: string) => Native().discard(path);
export const createSharedFolder = (parent: string, name: string) => Native().create(parent, name);
export const watchSharedFolders = (paths: string[]) => Native().watch(paths);
export const onSharedFolderChange = (listener: (paths: string[]) => void) => Native().addListener("onChange", (e) => listener(e.paths));
export const revealSharedFolder = (path: string) => SyncNative!.revealFolder(path);
