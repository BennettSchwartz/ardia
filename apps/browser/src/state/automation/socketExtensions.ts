import { webStoreExtensionId } from "@ardia/core";
import { errorText } from "../../lib/errors";
import { engineProfile } from "../browser/model";
import { configure, freshExtensions, openInExtensionProfile, refreshExtensions } from "../extensions/actions";
import type { InstalledExtension } from "../extensions/store";
import { ownEntry } from "./automationWindows";
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

export const NO_FOLDER_INSTALLS = "installing an unpacked folder from the socket isn't supported; use Settings › Extensions › Load Unpacked";

async function install(params: Record<string, unknown>, call: SocketCall) {
  if (params.folder !== undefined) throw new OpError("refused", NO_FOLDER_INSTALLS);
  if (params.webStore === undefined) throw new OpError("bad_request", "extensions.install takes webStore, a Chrome Web Store link or extension id.");
  const profileId = profileArg(params.profile);
  const engine = engineProfile(now(), profileId);
  const extensionId = webStoreExtensionId(params.webStore as string);
  if (!extensionId) throw new OpError("bad_request", "webStore is a Chrome Web Store link or extension id.");
  const already = (await refreshExtensions(engine)).find((x) => x.id === extensionId);
  stillThere(call, profileId, engine);
  if (already) return { waiting: false, installed: true, extensions: [{ id: already.id, name: already.name, version: already.version }] };
  openInExtensionProfile(`https://chromewebstore.google.com/detail/${extensionId}`, engine, { profileId });
  return { waiting: true, id: extensionId };
}

function plannedChanges(ext: InstalledExtension, params: Record<string, unknown>) {
  if (!ext.mayModify) throw new OpError("refused", `${ext.name} is installed by policy, so it can't be changed.`);
  if (params.siteAccess !== undefined && !ext.siteAccess) throw new OpError("refused", `${ext.name} asks for no site access, so there's nothing to choose.`);
  if (params.userScripts !== undefined && !ext.userScriptsAvailable) throw new OpError("refused", `${ext.name} doesn't use user scripts.`);
  if (params.incognito !== undefined && ext.path) throw new OpError("refused", `Allow in Incognito for ${ext.name}, an unpacked extension, needs engine support: Chromium doesn't report whether the loaded copy may run there.`);
  if (params.incognito !== undefined && typeof ext.incognitoAllowed !== "boolean") throw new OpError("refused", `Ardia can't confirm incognito eligibility for ${ext.name}, so Allow in Incognito stays as it is.`);
  if (params.incognito === true && ext.incognitoAllowed === false) throw new OpError("refused", `${ext.name} says it can't run in Incognito, so Allow in Incognito can't turn on.`);
  const siteAccess = params.siteAccess as SiteAccess | undefined;
  const rest: Parameters<typeof configure>[2] = {};
  if (params.incognito !== undefined) rest.incognito = params.incognito as boolean;
  if (params.userScripts !== undefined) rest.userScripts = params.userScripts as boolean;
  if (siteAccess === undefined && !Object.keys(rest).length) throw new OpError("bad_request", "extensions.configure needs siteAccess, incognito or userScripts.");
  return { siteAccess, rest };
}

export const siteAccessAfter = (asked: SiteAccess, grantedSites: readonly string[]) =>
  asked === "allSites" ? "ON_ALL_SITES" : asked === "specificSites" && grantedSites.length ? "ON_SPECIFIC_SITES" : "ON_CLICK";

async function loaded(engine: string): Promise<InstalledExtension[]> {
  try {
    return await freshExtensions(engine);
  } catch (error) {
    throw new OpError("failed", `Ardia couldn't read the profile's extensions from Chromium: ${errorText(error)}`);
  }
}

const SITE_ACCESS_OF: Record<string, SiteAccess> = { ON_ALL_SITES: "allSites", ON_SPECIFIC_SITES: "specificSites", ON_CLICK: "onClick" };

async function restoreSiteAccess(engine: string, ext: InstalledExtension): Promise<boolean> {
  const before = ext.siteAccess ? SITE_ACCESS_OF[ext.siteAccess] : undefined;
  return !!before && (await configure(engine, ext.id, { siteAccess: before }));
}

async function configureExtension(params: Record<string, unknown>, call: SocketCall) {
  const profileId = profileArg(params.profile);
  const engine = engineOf(params);
  const ext = (await loaded(engine)).find((x) => x.id === params.id);
  if (!ext) throw new OpError("no_window", `There's no extension ${String(params.id)} in that profile.`);
  const { siteAccess, rest } = plannedChanges(ext, params);
  stillThere(call, profileId, engine);
  if (siteAccess !== undefined && !(await configure(engine, ext.id, { siteAccess }))) {
    throw new OpError("failed", `Ardia didn't do that: Chromium kept ${ext.name}'s site access, so nothing changed.`);
  }
  if (Object.keys(rest).length) {
    if (siteAccess !== undefined) stillThere(call, profileId, engine);
    if (!(await configure(engine, ext.id, rest))) {
      const restored = siteAccess === undefined || (await restoreSiteAccess(engine, ext));
      throw new OpError("failed", `Chromium refused ${ext.name}'s ${Object.keys(rest).join(" and ")} change${siteAccess === undefined ? "" : restored ? ", so its site access was put back" : ", and putting its site access back failed too"}.`);
    }
  }
  const after = (await loaded(engine)).find((x) => x.id === ext.id);
  if (!after) throw new OpError("no_window", `${ext.name} is gone from that profile.`);
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
      "Add an extension from the Chrome Web Store, as Settings › Profiles › Extensions does: opens its store page, where the user adds it ({waiting}), or answers {installed} when it's already there. An unpacked folder is refused; Settings › Extensions › Load Unpacked adds one",
    params: obj({ profile: PROFILE, webStore: text("A Chrome Web Store link or extension id"), folder: text("Refused: unpacked folders install from Settings only") }),
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
