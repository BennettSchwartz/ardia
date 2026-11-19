import { webStoreExtensionId } from "@ardia/core";
import { errorText } from "../../lib/errors";
import { engineProfile } from "../browser/model";
import { configure, freshExtensions, openInExtensionProfile, refreshExtensions } from "../extensions/actions";
import type { InstalledExtension } from "../extensions/store";
import { ownEntry } from "./automationWindows";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, id, obj, oneOf, PROFILE, text } from "./socketSchema";
import { now, profileArg } from "./socketTargets";
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

type Change = { siteAccess: SiteAccess } | { incognito: boolean } | { userScripts: boolean };

export const SEPARATE_CALLS = "change site access and incognito in separate calls";

function requestedChange(params: Record<string, unknown>): Change {
  const asked = (["siteAccess", "incognito", "userScripts"] as const).filter((k) => params[k] !== undefined);
  if (!asked.length) throw new OpError("bad_request", "extensions.configure needs siteAccess, incognito or userScripts.");
  if (asked.includes("siteAccess") && asked.includes("incognito")) throw new OpError("bad_request", SEPARATE_CALLS);
  if (asked.length > 1) throw new OpError("bad_request", `change ${asked.join(" and ")} in separate calls`);
  const key = asked[0]!;
  return { [key]: params[key] } as Change;
}

function checkedChange(ext: InstalledExtension, change: Change) {
  if (!ext.mayModify) throw new OpError("refused", `${ext.name} is installed by policy, so it can't be changed.`);
  if ("siteAccess" in change && !ext.siteAccess) throw new OpError("refused", `${ext.name} asks for no site access, so there's nothing to choose.`);
  if ("userScripts" in change && !ext.userScriptsAvailable) throw new OpError("refused", `${ext.name} doesn't use user scripts.`);
  if (!("incognito" in change)) return;
  if (typeof ext.incognitoAllowed !== "boolean") throw new OpError("refused", `Ardia can't confirm incognito eligibility for ${ext.name}, so Allow in Incognito stays as it is.`);
  if (ext.path) throw new OpError("refused", `Allow in Incognito for ${ext.name}, an unpacked extension, needs engine support: Chromium doesn't report whether the loaded copy may run there.`);
  if (change.incognito && !ext.incognitoAllowed) throw new OpError("refused", `${ext.name} says it can't run in Incognito, so Allow in Incognito can't turn on.`);
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

function took(after: InstalledExtension, change: Change) {
  if ("siteAccess" in change) return after.siteAccess === siteAccessAfter(change.siteAccess, after.sites ?? []);
  if ("incognito" in change) return after.incognito === change.incognito;
  return !!after.userScripts === change.userScripts;
}

async function configureExtension(params: Record<string, unknown>, call: SocketCall) {
  const change = requestedChange(params);
  const profileId = profileArg(params.profile);
  const engine = engineOf(params);
  const ext = (await loaded(engine)).find((x) => x.id === params.id);
  if (!ext) throw new OpError("no_window", `There's no extension ${String(params.id)} in that profile.`);
  checkedChange(ext, change);
  stillThere(call, profileId, engine);
  const what = Object.keys(change)[0];
  if (!(await configure(engine, ext.id, change))) throw new OpError("failed", `Ardia didn't do that: Chromium refused ${ext.name}'s ${what} change, so nothing changed.`);
  const after = (await loaded(engine)).find((x) => x.id === ext.id);
  if (!after) throw new OpError("no_window", `${ext.name} is gone from that profile.`);
  if (!took(after, change)) throw new OpError("failed", `Ardia didn't do that: Chromium kept ${ext.name}'s ${what} as it was.`);
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
    description: "Change one of an extension's settings per call, as its page in Settings does: site access, Allow in Incognito or Allow User Scripts; a request naming more than one is refused",
    params: obj(
      { profile: PROFILE, id: id("An extension id from extensions.list"), siteAccess: oneOf(SITE_ACCESS, "Which sites it can read and change; alone in its call"), incognito: bool("Allow in Incognito; alone in its call"), userScripts: bool("Allow User Scripts; alone in its call") },
      ["id"],
    ),
    result: "{id, name, incognito, userScripts, siteAccess, sites}",
    run: configureExtension,
  },
];
