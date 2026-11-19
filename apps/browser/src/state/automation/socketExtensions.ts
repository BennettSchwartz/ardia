import { webStoreExtensionId } from "@ardia/core";
import { inspectUnpackedExtension } from "../../platform/extensions";
import { errorText } from "../../lib/errors";
import { engineProfile } from "../browser/model";
import { configure, findExtension, openInExtensionProfile, refreshExtensions, takeInstalledId, useExtensions } from "../extensions/actions";
import { focusWindow } from "../windows/nativeWindow";
import { extensionProfile, nextInstallKey, type InstallRequest, type InstalledExtension } from "../extensions/store";
import { useBrowser } from "../browser/store";
import { eligibleKind, ownEntry } from "./automationWindows";
import { folderProblem } from "./extensionFolders";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, id, obj, oneOf, PROFILE, text } from "./socketSchema";
import { expect, now, profileArg } from "./socketTargets";
import { OpError } from "./workspaceTargets";

const SITE_ACCESS = ["allSites", "specificSites", "onClick"] as const;
type SiteAccess = (typeof SITE_ACCESS)[number];
const SITE_ACCESS_STATE: Record<SiteAccess, string> = { allSites: "ON_ALL_SITES", specificSites: "ON_SPECIFIC_SITES", onClick: "ON_CLICK" };

const engineOf = (params: Record<string, unknown>) => engineProfile(now(), profileArg(params.profile));

function stillThere(call: SocketCall, profileId: string, engine: string) {
  call.stillServing();
  if (!ownEntry(now().profiles, profileId) || engineProfile(now(), profileId) !== engine) throw new OpError("no_window", `Profile ${profileId} closed before Ardia made the change, so nothing changed.`);
}

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

type Outcome = { installed: string } | { error: string } | { cancelled: true };

const SHEET_CLOSED = "The window showing the install sheet closed before the user answered.";

function settled(request: InstallRequest): Promise<Outcome> {
  return new Promise((resolve) => {
    const check = () => {
      const id = takeInstalledId(request.key);
      if (id) return finish({ installed: id });
      const current = useExtensions.getState().install;
      if (current?.key !== request.key) return finish(now().windows[request.windowId] ? { cancelled: true } : { error: SHEET_CLOSED });
      if (current.status === "error") return finish({ error: current.error });
      if (current.status === "installing" || now().windows[request.windowId]) return;
      useExtensions.setState({ install: null });
      finish({ error: SHEET_CLOSED });
    };
    const stops = [useExtensions.subscribe(check), useBrowser.subscribe(check)];
    function finish(outcome: Outcome) {
      stops.forEach((stop) => stop());
      resolve(outcome);
    }
  });
}

function refuseWhileSheetShows() {
  if (useExtensions.getState().install) throw new OpError("refused", "An install sheet is already showing; the user answers it first.");
}

async function installFolder(call: SocketCall, engine: string, profileId: string, folder: string) {
  const problem = folderProblem(folder);
  if (problem) throw new OpError("bad_request", problem);
  refuseWhileSheetShows();
  let pkg;
  try {
    pkg = await inspectUnpackedExtension(folder);
  } catch (error) {
    throw new OpError("bad_request", `${folder} isn't an extension Ardia can load: ${errorText(error)}`);
  }
  stillThere(call, profileId, engine);
  const canonical = folderProblem(pkg.path);
  if (canonical) throw new OpError("bad_request", canonical);
  if (!pkg.digest) throw new OpError("refused", "Ardia can't pin an unpacked extension's files on this platform, so it can't be sure the user adds what the sheet shows.");
  refuseWhileSheetShows();
  const windowId = windowShowing(engine, profileId);
  const request: InstallRequest = { key: nextInstallKey(), windowId, profile: engine, source: "unpacked", status: "ready", pkg };
  useExtensions.setState({ install: request });
  void focusWindow(windowId);
  const outcome = await settled(request);
  if ("error" in outcome) throw new OpError("failed", outcome.error);
  if ("cancelled" in outcome) return { installed: false, extensions: [] };
  const added = (await refreshExtensions(engine)).find((x) => x.id === outcome.installed);
  return { installed: true, extensions: [{ id: outcome.installed, name: added?.name ?? pkg.name, version: added?.version ?? pkg.version }] };
}

async function install(params: Record<string, unknown>, call: SocketCall) {
  if ((params.webStore === undefined) === (params.folder === undefined)) throw new OpError("bad_request", "extensions.install takes webStore or folder, one of them.");
  const profileId = profileArg(params.profile);
  const engine = engineProfile(now(), profileId);
  if (params.folder !== undefined) return installFolder(call, engine, profileId, params.folder as string);
  const extensionId = webStoreExtensionId(params.webStore as string);
  if (!extensionId) throw new OpError("bad_request", "webStore is a Chrome Web Store link or extension id.");
  const already = (await refreshExtensions(engine)).find((x) => x.id === extensionId);
  if (already) return { waiting: false, installed: true, extensions: [{ id: already.id, name: already.name, version: already.version }] };
  stillThere(call, profileId, engine);
  openInExtensionProfile(`https://chromewebstore.google.com/detail/${extensionId}`, engine, { profileId });
  return { waiting: true, id: extensionId };
}

function plannedChanges(ext: InstalledExtension, params: Record<string, unknown>) {
  if (!ext.mayModify) throw new OpError("refused", `${ext.name} is installed by policy, so it can't be changed.`);
  if (params.siteAccess !== undefined && !ext.siteAccess) throw new OpError("refused", `${ext.name} asks for no site access, so there's nothing to choose.`);
  if (params.userScripts !== undefined && !ext.userScriptsAvailable) throw new OpError("refused", `${ext.name} doesn't use user scripts.`);
  const siteAccess = params.siteAccess as SiteAccess | undefined;
  const rest: Parameters<typeof configure>[2] = {};
  if (params.incognito !== undefined) rest.incognito = params.incognito as boolean;
  if (params.userScripts !== undefined) rest.userScripts = params.userScripts as boolean;
  if (siteAccess === undefined && !Object.keys(rest).length) throw new OpError("bad_request", "extensions.configure needs siteAccess, incognito or userScripts.");
  return { siteAccess, rest };
}

export const siteAccessAfter = (asked: SiteAccess, grantedSites: readonly string[]) =>
  asked === "allSites" ? "ON_ALL_SITES" : asked === "specificSites" && grantedSites.length ? "ON_SPECIFIC_SITES" : "ON_CLICK";

async function configureExtension(params: Record<string, unknown>, call: SocketCall) {
  const profileId = profileArg(params.profile);
  const engine = engineOf(params);
  const ext = await extensionIn(engine, params.id);
  const { siteAccess, rest } = plannedChanges(ext, params);
  stillThere(call, profileId, engine);
  if (siteAccess !== undefined && !(await configure(engine, ext.id, { siteAccess }))) {
    throw new OpError("failed", `Ardia didn't do that: Chromium kept ${ext.name}'s site access, so nothing changed.`);
  }
  if (Object.keys(rest).length) {
    if (siteAccess !== undefined) stillThere(call, profileId, engine);
    await configure(engine, ext.id, rest);
  }
  const after = await extensionIn(engine, ext.id);
  expect(
    (rest.incognito === undefined || after.incognito === rest.incognito) &&
      (rest.userScripts === undefined || !!after.userScripts === rest.userScripts) &&
      (siteAccess === undefined || after.siteAccess === siteAccessAfter(siteAccess, after.sites ?? [])),
    `${ext.name}'s settings didn't change.`,
  );
  return { id: after.id, name: after.name, incognito: after.incognito, userScripts: !!after.userScripts, siteAccess: after.siteAccess ?? null, sites: after.sites ?? [] };
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
    result: "{id, name, incognito, userScripts, siteAccess, sites}",
    run: configureExtension,
  },
];
