import assert from "node:assert/strict";
import { test } from "node:test";
import { shellNativeModules } from "../../test-native/shell.ts";

let duringResolve = () => {};
let resolves = 0;

globalThis.acTestNativeModules = {
  ArdiaDialogs: { ...shellNativeModules.ArdiaDialogs, pickFolder: async () => "/scratch/Ardia Shared/Team" },
  ArdiaSharedFolders: {
    location: () => ({ path: "/scratch/Ardia Shared", iCloudAvailable: true, iCloudPath: "/scratch" }),
    resolve: async (path) => (++resolves === 2 && duringResolve(), { path, device: 1, inode: path.endsWith("Old") ? 23 : 21 }),
    read: async () => ({ exists: true, root: { entries: [], manifest: null, manifestPending: false } }),
    apply: async () => ({ conflicts: [] }),
    create: async (parent, _identity, name) => ({ path: `${parent}/${name}`, device: 1, inode: 22 }),
    watch: () => {},
    addListener: () => ({ remove() {} }),
  },
};

const { useBrowser } = await import("../browser/store.ts");
const { bindFolder, boundFolders, unbindFolder } = await import("./store.ts");
const { addSharedFolder } = await import("./actions.ts");
const S = () => useBrowser.getState();

test("adding a folder while the window switches profile binds nothing to either profile", async () => {
  S().hydrate({});
  const windowId = S().createWindow({ url: "https://home.example/" });
  const before = S().windows[windowId].profileId;
  const other = S().createProfile({ name: "Other" });
  bindFolder(before, "legacy-key", "/scratch/Ardia Shared/Old");
  duringResolve = () => S().switchProfile(windowId, other);
  await addSharedFolder(windowId);
  assert.equal(resolves, 2, "the switch landed while the existing bindings were checked");
  assert.equal(S().windows[windowId].profileId, other, "the window switched");
  assert.deepEqual(boundFolders().map((b) => b.key), ["legacy-key"], "nothing new was bound");
  assert.equal(Object.values(S().groups).filter((g) => g.pinned).length, 0, "no shared group was made");
  unbindFolder(before, "legacy-key");
});
