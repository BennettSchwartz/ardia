import type { JsonSchema } from "../../lib/jsonSchema";
import { errorText } from "../../lib/errors";
import { failure, type MethodError } from "./automationMethods";
import { schemaProblem } from "./socketSchema";
import { OpError } from "./workspaceTargets";

export type SocketBody = { result: unknown } | { error: MethodError };

export type MethodSpec = {
  name: string;
  mutates: boolean;
  description: string;
  params: JsonSchema;
  result: string;
  run?: (params: Record<string, unknown>) => unknown;
};

export type MethodEntry = { name: string; area: string; mutates: boolean; description: string; params: JsonSchema; result: string };

export const SOCKET_FAMILIES = ["core", "workspace", "tabs", "windows", "profiles", "splits", "peek", "bookmarks", "history", "downloads", "settings", "sites", "extensions", "plugins", "media", "sync", "secrets", "pins", "favicons", "shared_folders", "live", "presets", "air_traffic"] as const;
export type SocketFamily = (typeof SOCKET_FAMILIES)[number];

const FAMILY_OF_AREA: Record<string, SocketFamily> = {
  apply: "workspace",
  workspace: "workspace",
  offscreen: "workspace",
  run: "workspace",
  tabs: "tabs",
  closed: "tabs",
  windows: "windows",
  littleArdia: "windows",
  profiles: "profiles",
  splits: "splits",
  peek: "peek",
  bookmarks: "bookmarks",
  history: "history",
  downloads: "downloads",
  settings: "settings",
  search: "settings",
  sites: "sites",
  extensions: "extensions",
  plugins: "plugins",
  media: "media",
  sync: "sync",
  passwords: "secrets",
  autofill: "secrets",
  pins: "pins",
  favicons: "favicons",
  sharedFolders: "shared_folders",
  live: "live",
  presets: "presets",
  airTraffic: "air_traffic",
};

export const areaOf = (name: string) => name.split(".")[0]!;
export const familyOf = (name: string): SocketFamily => FAMILY_OF_AREA[areaOf(name)] ?? "core";

const LOOSE: JsonSchema = { type: "object" };

const core = (name: string, mutates: boolean, description: string, result: string, params: JsonSchema = LOOSE): MethodSpec => ({ name, mutates, description, params, result });

export const CORE_METHODS: MethodSpec[] = [
  core("hello", false, "Protocol handshake; send it first with your protocol", "{app, version, protocol, minClientProtocol}", { type: "object", properties: { protocol: { type: "integer" }, caller: { type: "object" } } }),
  core("caller", false, "Note the caller named in hello as the one running now", "{ok}"),
  core("methods", false, "Every method the socket answers, with its params schema, result and whether it changes anything", "[{name, area, mutates, description, params, result}]", { type: "object", properties: {}, additionalProperties: false }),
  core("commands", false, "The menu commands run takes", "[{id, title, …}]"),
  core("windows", false, "Windows and their tabs, with each tab's DevTools target", "[{id, kind, focused, profile, profileName, tabs}]"),
  core("workspace", false, "The sidebar tree of a window or profile: pinned, groups and tabs", "{windows, …}", { type: "object", properties: { window: { type: ["string", "null"] }, profile: { type: ["string", "null"] }, usage: { type: "boolean" } } }),
  core("apply", true, "A batch of ops on tabs, groups and pins: open, tab.*, group.*", "{ok, applied, results, tabs, groups, windows}", { type: "object", properties: { ops: { type: "array" } }, required: ["ops"] }),
  core("run", true, "Run a menu command in a window or on a tab", "{ok}", { type: "object", properties: { command: { type: "string" }, arg: { type: ["string", "null"] }, window: { type: ["string", "null"] }, tab: { type: ["string", "null"] } }, required: ["command"] }),
  core("offscreen", true, "Move a tab the command opened off-screen", "{ok}", { type: "object", properties: { tab: { type: "string" } }, required: ["tab"] }),
  core("subscribe", false, "Receive events (and serve decide hooks) on this connection", "{ok, served}", { type: "object", properties: { events: { type: "array" } }, required: ["events"] }),
  core("answer", false, "Answer a decide hook", "{…}"),
  core("plugins", false, "Installed plugins", "[{name, title, version, enabled, active, tools, …}]"),
  core("plugins.official", false, "The official plugins Ardia offers", "[…]"),
  core("plugins.enable", true, "Ask the user to turn a plugin on (shows its consent sheet)", "{ok} | {waiting}", { type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
  core("plugins.disable", true, "Turn a plugin off", "{ok}", { type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
  core("plugins.remove", true, "Remove a plugin", "{ok}", { type: "object", properties: { name: { type: "string" } }, required: ["name"] }),
  core("plugins.call", true, "Call a plugin's tool", "the tool's result", { type: "object", properties: { plugin: { type: "string" }, tool: { type: "string" }, input: {} }, required: ["plugin", "tool"] }),
];

let added: MethodSpec[] = [];
let byName = new Map<string, MethodSpec>();

export function registerSocketMethods(specs: readonly MethodSpec[]) {
  for (const spec of specs) {
    if (byName.has(spec.name) || CORE_METHODS.some((c) => c.name === spec.name)) throw new Error(`Socket method ${spec.name} is defined twice.`);
    byName.set(spec.name, spec);
  }
  added = [...added, ...specs];
}

export const methodsCatalog = (): MethodEntry[] =>
  [...CORE_METHODS, ...added].map(({ name, mutates, description, params, result }) => ({ name, area: areaOf(name), mutates, description, params, result }));

const asBody = (thrown: unknown): SocketBody => (thrown instanceof OpError ? failure(thrown.code, thrown.message) : failure("failed", errorText(thrown)));

export function runSocketMethod(name: string, params: Record<string, unknown>): SocketBody | Promise<SocketBody> | null {
  const spec = byName.get(name);
  if (!spec?.run) return null;
  const problem = schemaProblem(spec.params, params, "params");
  if (problem) return failure("bad_request", `${name}: ${problem}`);
  try {
    const out = spec.run(params);
    if (out instanceof Promise) return out.then((result) => ({ result }), asBody);
    return { result: out };
  } catch (thrown) {
    return asBody(thrown);
  }
}
