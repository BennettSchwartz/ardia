import { webStoreExtensionId } from "@ardia/core";
import { inspectUnpackedExtension } from "../../platform/extensions";
import { errorText } from "../../lib/errors";
import { engineProfile } from "../browser/model";
import { configure, findExtension, openInExtensionProfile, refreshExtensions, useExtensions } from "../extensions/actions";
import { focusWindow } from "../windows/nativeWindow";
import { extensionProfile, type InstallRequest, type InstalledExtension } from "../extensions/store";
import { eligibleKind } from "./automationWindows";
import type { MethodSpec } from "./socketCatalog";
import { bool, id, obj, oneOf, PROFILE, text } from "./socketSchema";
import { expect, now, profileArg } from "./socketTargets";
import { OpError } from "./workspaceTargets";

const SITE_ACCESS = ["allSites", "specificSites", "onClick"] as const;
type SiteAccess = (typeof SITE_ACCESS)[number];
const SITE_ACCESS_STATE: Record<SiteAccess, string> = { allSites: "ON_ALL_SITES", specificSites: "ON_SPECIFIC_SITES", onClick: "ON_CLICK" };

const engineOf = (params: Record<string, unknown>) => engineProfile(now(), profileArg(params.profile));

async function extensionIn(engine: string, extensionId: unknown): Promise<InstalledExtension> {
  const known = findExtension(engine, extensionId as string) ?? (await refreshExtensions(engine)).find((x) => x.id === extensionId);
  if (!known) throw new OpError("no_window", `There's no extension ${String(extensionId)} in that profile.`);
  return known;
}

function windowShowing(engine: string, profileId: string): string {
  const s = now();
  const shows = (w: string) => eligibleKind(s, w) === "normal" && extensionProfile(s, w) === engine;
  const found = [...s.ui.focusOrder, ...s.windowOrder].find(shows);
  if (found) return found;
  const made = s.createWindow({ profileId });
  expect(!!made && !!now().windows[made], "no window opened to show the install sheet.");
  return made;
}

function settled(request: InstallRequest): Promise<InstallRequest | null> {
  return new Promise((resolve) => {
    const done = (next: InstallRequest | null) => {
      stop();
      resolve(next);
    };
    const stop = useExtensions.subscribe((e) => {
      if (e.install === request) return;
      if (e.install && e.install.windowId === request.windowId && e.install.profile === request.profile && e.install.status === "installing") return;
      done(e.install && e.install.windowId === request.windowId && e.install.status === "error" ? e.install : null);
    });
  });
}

async function installFolder(engine: string, profileId: string, folder: string) {
  if (!folder.startsWith("/")) throw new OpError("bad_request", "folder is an absolute path to an unpacked extension (the folder holding manifest.json).");
  let pkg;
  try {
    pkg = await inspectUnpackedExtension(folder);
  } catch (error) {
    throw new OpError("bad_request", `${folder} isn't an extension Ardia can load: ${errorText(error)}`);
  }
  const before = new Set((await refreshExtensions(engine)).map((x) => x.id));
  const windowId = windowShowing(engine, profileId);
  const request: InstallRequest = { windowId, profile: engine, source: "unpacked", status: "ready", pkg };
  useExtensions.setState({ install: request });
  void focusWindow(windowId);
  const outcome = await settled(request);
  if (outcome?.status === "error") throw new OpError("failed", outcome.error);
  const added = (await refreshExtensions(engine)).filter((x) => !before.has(x.id));
  return { installed: added.length > 0, extensions: added.map((x) => ({ id: x.id, name: x.name, version: x.version })) };
}

async function install(params: Record<string, unknown>) {
  if ((params.webStore === undefined) === (params.folder === undefined)) throw new OpError("bad_request", "extensions.install takes webStore or folder, one of them.");
  const profileId = profileArg(params.profile);
  const engine = engineProfile(now(), profileId);
  if (params.folder !== undefined) return installFolder(engine, profileId, params.folder as string);
  const extensionId = webStoreExtensionId(params.webStore as string);
  if (!extensionId) throw new OpError("bad_request", "webStore is a Chrome Web Store link or extension id.");
  const already = (await refreshExtensions(engine)).find((x) => x.id === extensionId);
  if (already) return { waiting: false, installed: true, extensions: [{ id: already.id, name: already.name, version: already.version }] };
  openInExtensionProfile(`https://chromewebstore.google.com/detail/${extensionId}`, engine, { profileId });
  return { waiting: true, id: extensionId };
}

async function configureExtension(params: Record<string, unknown>) {
  const engine = engineOf(params);
  const ext = await extensionIn(engine, params.id);
  if (!ext.mayModify) throw new OpError("refused", `${ext.name} is installed by policy, so it can't be changed.`);
  const options: Parameters<typeof configure>[2] = {};
  if (params.siteAccess !== undefined) {
    if (!ext.siteAccess) throw new OpError("refused", `${ext.name} asks for no site access, so there's nothing to choose.`);
    options.siteAccess = params.siteAccess as SiteAccess;
  }
  if (params.incognito !== undefined) options.incognito = params.incognito as boolean;
  if (params.userScripts !== undefined) {
    if (!ext.userScriptsAvailable) throw new OpError("refused", `${ext.name} doesn't use user scripts.`);
    options.userScripts = params.userScripts as boolean;
  }
  if (!Object.keys(options).length) throw new OpError("bad_request", "extensions.configure needs siteAccess, incognito or userScripts.");
  await configure(engine, ext.id, options);
  const after = await extensionIn(engine, ext.id);
  expect(
    (options.incognito === undefined || after.incognito === options.incognito) &&
      (options.userScripts === undefined || !!after.userScripts === options.userScripts) &&
      (options.siteAccess === undefined || after.siteAccess === SITE_ACCESS_STATE[options.siteAccess]),
    `${ext.name}'s settings didn't change.`,
  );
  return { id: after.id, name: after.name, incognito: after.incognito, userScripts: !!after.userScripts, siteAccess: after.siteAccess ?? null };
}

export const EXTENSION_METHODS: MethodSpec[] = [
  {
    name: "extensions.install",
    mutates: true,
    description:
      "Add an extension, as Settings › Profiles › Extensions does: webStore opens its Chrome Web Store page, where the user adds it ({waiting}); folder shows Ardia's install sheet for an unpacked extension and answers once the user decides",
    params: obj({ profile: PROFILE, webStore: text("A Chrome Web Store link or extension id"), folder: text("The absolute path of an unpacked extension's folder") }),
    result: "{waiting, id} | {installed, extensions}",
    run: install,
  },
  {
    name: "extensions.configure",
    mutates: true,
    description: "Change an extension's settings, as its page in Settings does: site access, Allow in Incognito, Allow User Scripts",
    params: obj(
      { profile: PROFILE, id: id("An extension id from extensions.list"), siteAccess: oneOf(SITE_ACCESS, "Which sites it can read and change"), incognito: bool("Allow in Incognito"), userScripts: bool("Allow User Scripts") },
      ["id"],
    ),
    result: "{id, name, incognito, userScripts, siteAccess}",
    run: configureExtension,
  },
];
