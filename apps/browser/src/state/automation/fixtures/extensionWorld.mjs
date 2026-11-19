export const row = (id, extra = {}) => ({ id, name: id, version: "1.0", description: "", enabled: true, state: "ENABLED", icon: "", permissions: [], siteAccess: null, sites: [], optionsUrl: null, pinned: false, incognito: false, fileAccess: false, mayModify: true, errors: [], ...extra });

export function extensionWorld() {
  const list = [];
  const folders = new Map();
  const stages = new Map();
  const installs = [];
  const gates = { inspect: null, install: null, list: null };
  let stageIds = 0;
  const pkg = { version: "1.0", description: "", manifestVersion: 3, icon: null, permissions: [], optionalPermissions: [], hostPermissions: [], hasAction: false, popup: null, optionsPage: null, sidePanel: null };
  const engine = {
    list: async () => {
      const snapshot = list.map((x) => ({ ...x }));
      if (gates.list) await gates.list;
      return snapshot;
    },
    install: async (path, _profile, digest, staged) => {
      const shown = staged ? stages.get(staged) : folders.get(path);
      if (!shown || (staged && digest !== shown.digest)) throw new Error("Ardia's copy of the extension changed after the sheet showed it, so nothing was added.");
      if (gates.install) await gates.install;
      if (!list.some((x) => x.id === shown.id)) list.push(row(shown.id, { version: shown.version ?? "1.0" }));
      installs.push({ path, staged, id: shown.id, version: shown.version ?? "1.0" });
      return shown.id;
    },
    reload: async () => {},
    uninstall: async () => {},
    configure: async (id, _profile, options) => {
      const x = list.find((e) => e.id === id);
      if (options.incognito !== undefined) x.incognito = options.incognito;
      if (options.userScripts !== undefined) x.userScripts = options.userScripts;
      if (options.siteAccess) {
        if (x.lockedSites) throw new Error("Can't change this extension's site access");
        x.siteAccess = options.siteAccess === "allSites" ? "ON_ALL_SITES" : x.sites.length && options.siteAccess === "specificSites" ? "ON_SPECIFIC_SITES" : "ON_CLICK";
      }
    },
    inspect: async (path) => {
      if (gates.inspect) await gates.inspect;
      const folder = folders.get(path);
      if (!folder) throw new Error("Manifest file is missing or unreadable");
      if (!folder.digest) return { ...pkg, name: folder.id, path };
      const staged = `/data/Ardia Unpacked Extensions/stage-${++stageIds}`;
      stages.set(staged, { ...folder });
      return { ...pkg, name: folder.id, version: folder.version ?? "1.0", path, digest: folder.digest, staged };
    },
  };
  globalThis.acTestUserScripts = { ...(globalThis.acTestUserScripts ?? {}), engine };
  return { list, folders, stages, installs, gates };
}

export function gate() {
  let open;
  const shut = new Promise((resolve) => (open = resolve));
  return { shut, open: () => open() };
}
