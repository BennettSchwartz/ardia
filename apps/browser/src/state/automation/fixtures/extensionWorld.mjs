export const row = (id, extra = {}) => ({ id, name: id, version: "1.0", description: "", enabled: true, state: "ENABLED", icon: "", permissions: [], siteAccess: null, sites: [], optionsUrl: null, pinned: false, incognito: false, fileAccess: false, mayModify: true, errors: [], ...extra });

export function extensionWorld() {
  const list = [];
  const folders = new Map();
  const stages = new Map();
  const installs = [];
  const gates = { inspect: null, install: null, list: null, reject: null, listFails: false, breakListsOnWrite: false };
  const reloads = [];
  const uninstalls = [];
  let stageIds = 0;
  const pkg = { version: "1.0", description: "", manifestVersion: 3, icon: null, permissions: [], optionalPermissions: [], hostPermissions: [], hasAction: false, popup: null, optionsPage: null, sidePanel: null };
  const engine = {
    list: async () => {
      const snapshot = list.map((x) => ({ ...x }));
      if (gates.list) await gates.list;
      if (gates.listFails) throw new Error("Chromium didn't answer");
      return snapshot;
    },
    install: async (path, _profile, digest, staged) => {
      const shown = staged ? stages.get(staged) : folders.get(path);
      if (!shown || (staged && digest !== shown.digest)) throw new Error("Ardia's copy of the extension changed after the sheet showed it, so nothing was added.");
      if (gates.install) await gates.install;
      if (gates.reject) throw new Error(gates.reject);
      const id = staged ? shown.installId : shown.id;
      const existing = list.find((x) => x.id === id);
      const fields = { version: shown.version ?? "1.0", ...(staged ? { path: shown.installPath, managedSource: path, managedDigest: digest } : {}) };
      if (existing) Object.assign(existing, fields);
      else list.push(row(id, fields));
      installs.push({ path, staged, id, version: shown.version ?? "1.0" });
      return id;
    },
    reload: async (id) => void reloads.push(id),
    uninstall: async (id, _profile, managed) => {
      uninstalls.push({ id, managed });
      list.splice(list.findIndex((x) => x.id === id), 1);
    },
    configure: async (id, _profile, options) => {
      const x = list.find((e) => e.id === id);
      if (gates.breakListsOnWrite) gates.listFails = true;
      if (options.incognito !== undefined) x.incognito = options.incognito;
      if (options.userScripts !== undefined) x.userScripts = options.userScripts;
      if (options.siteAccess) {
        if (x.lockedSites) throw new Error("Can't change this extension's site access");
        x.siteAccess = options.siteAccess === "allSites" ? "ON_ALL_SITES" : x.sites.length && options.siteAccess === "specificSites" ? "ON_SPECIFIC_SITES" : "ON_CLICK";
      }
    },
    inspect: async (path, profile) => {
      if (gates.inspect) await gates.inspect;
      const folder = folders.get(path);
      if (!folder) throw new Error("Manifest file is missing or unreadable");
      if (!folder.digest) return { ...pkg, name: folder.id, path };
      const staged = `/data/Ardia Unpacked Extensions/${profile || "default"}/stage-${++stageIds}`;
      const installPath = `/data/Ardia Unpacked Extensions/${profile || "default"}/${path.replaceAll("/", "_")}/live`;
      const installId = folder.key ?? folder.id;
      stages.set(staged, { ...folder, installPath, installId });
      return { ...pkg, name: folder.id, version: folder.version ?? "1.0", path, digest: folder.digest, staged, installId, installPath };
    },
  };
  globalThis.acTestUserScripts = { ...(globalThis.acTestUserScripts ?? {}), engine };
  return { list, folders, stages, installs, gates, reloads, uninstalls };
}

export function gate() {
  let open;
  const shut = new Promise((resolve) => (open = resolve));
  return { shut, open: () => open() };
}
