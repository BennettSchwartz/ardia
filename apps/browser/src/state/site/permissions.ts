import {
  answerPermissionIfPending,
  onPermission,
  onPermissionDismissed,
  resolvePermission,
  type PermissionKind,
  type PermissionRequest,
  type PermissionResult,
} from "../../platform/permissions";
import { ensureNotificationPermission } from "./webNotifications";
import { ensureLocationPermission } from "./locationAccess";
import { useBrowser } from "../browser/store";
import { patchPage, pageOf, usePages } from "../tabs/pageState";
import { startDeviceChoosers } from "./deviceChoosers";
import { originForSecurityDisplay } from "../../lib/url";
import { getSiteSettings, type SiteSettingType } from "../../platform/siteSettings";
import { currentEngineProfile } from "../browser/current";
import { permissionGate } from "./permissionGate";
import { noteNotificationRequestAutoDenied } from "../telemetry/notificationRequestCounts";

const queues = new Map<string, PermissionRequest[]>();
let started = false;

export function startPermissionPrompts() {
  if (started) return;
  started = true;
  startDeviceChoosers();
  onPermission((request) => {
    if (request.tabId) gated(request.tabId, request);
  });
  onPermissionDismissed(({ id }) => {
    deciding.get(id)?.controller.abort();
    deciding.delete(id);
    drop(id);
  });
}

const deciding = new Map<string, { controller: AbortController; tabId: string }>();

const turnedDownUnasked = (request: PermissionRequest) =>
  useBrowser.getState().settings.blockNotificationRequests && request.permissions.length > 0 && request.permissions.every((kind) => kind === "notifications");

function gated(tabId: string, request: PermissionRequest) {
  if (turnedDownUnasked(request)) {
    noteNotificationRequestAutoDenied();
    return void resolvePermission(request.id, "deny", true);
  }
  const gate = permissionGate();
  if (!gate) return enqueue(tabId, request);
  const controller = new AbortController();
  const settle = (verdict: "deny" | "ask") => {
    if (controller.signal.aborted) return;
    deciding.delete(request.id);
    if (verdict === "deny") void resolvePermission(request.id, "deny", false);
    else enqueue(tabId, request);
  };
  let verdict: ReturnType<typeof gate>;
  try {
    verdict = gate(request, controller.signal);
  } catch {
    verdict = "ask";
  }
  if (!(verdict instanceof Promise)) return settle(verdict);
  deciding.set(request.id, { controller, tabId });
  void verdict.then(settle, () => settle("ask"));
}

function enqueue(tabId: string, request: PermissionRequest) {
  if (pageOf(tabId).permission?.id === request.id || queues.get(tabId)?.some((r) => r.id === request.id)) return;
  if (!pageOf(tabId).permission) patchPage(tabId, { permission: request });
  else queues.set(tabId, [...(queues.get(tabId) ?? []), request]);
}

function next(tabId: string) {
  const queue = queues.get(tabId) ?? [];
  patchPage(tabId, { permission: queue.shift() ?? null });
  if (queue.length) queues.set(tabId, queue);
  else queues.delete(tabId);
}

function drop(id: string) {
  for (const [tabId, page] of Object.entries(usePages.getState().pages)) {
    if (page.permission?.id === id) next(tabId);
  }
  for (const [tabId, queue] of queues) queues.set(tabId, queue.filter((r) => r.id !== id));
}

function answered(tabId: string, request: PermissionRequest, result: PermissionResult) {
  if (result === "accept" && request.permissions.includes("notifications")) {
    void ensureNotificationPermission(useBrowser.getState().tabs[tabId]?.windowId);
  }
  if (result === "accept" && request.permissions.includes("location")) {
    void ensureLocationPermission(useBrowser.getState().tabs[tabId]?.windowId);
  }
  next(tabId);
}

export function answerPermission(tabId: string, requestId: string, result: PermissionResult, remember = result !== "dismiss") {
  const request = pageOf(tabId).permission;
  if (!request || request.id !== requestId) return;
  void resolvePermission(request.id, result, remember);
  answered(tabId, request, result);
}

const READBACK: Partial<Record<PermissionKind, SiteSettingType>> = {
  camera: "camera",
  microphone: "microphone",
  cameraPanTiltZoom: "cameraPanTiltZoom",
  location: "location",
  notifications: "notifications",
  clipboard: "clipboard",
  midi: "midi",
  sensors: "sensors",
  windowManagement: "windowManagement",
  localFonts: "localFonts",
  idleDetection: "idleDetection",
  storageAccess: "storageAccess",
  fileSystem: "fileSystem",
  keyboardLock: "keyboardLock",
  pointerLock: "pointerLock",
  multipleDownloads: "automaticDownloads",
};

export const READBACK_WAIT_MS = 5000;

export const confirmableKinds = (kinds: readonly PermissionKind[]) => kinds.length > 0 && kinds.every((kind) => READBACK[kind]);

async function readsBack(tabId: string, request: PermissionRequest, value: "allow" | "block", deadline: number) {
  const tab = useBrowser.getState().tabs[tabId];
  if (!tab) return false;
  const engine = request.id.startsWith("wk-") ? "webkit" : "chromium";
  const types = request.permissions.map((kind) => READBACK[kind]!);
  for (;;) {
    const settings = await getSiteSettings(currentEngineProfile(tab.profileId), new URL(request.origin).origin, engine).catch(() => null);
    if (settings && types.every((type) => settings[type]?.value === value)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function answerPermissionConfirmed(tabId: string, requestId: string, result: "accept" | "deny"): Promise<"confirmed" | "gone" | "unknown"> {
  const request = pageOf(tabId).permission;
  if (!request || request.id !== requestId) return "gone";
  const deadline = Date.now() + READBACK_WAIT_MS;
  if (!(await answerPermissionIfPending(request.id, result, true))) {
    if (pageOf(tabId).permission?.id === request.id) next(tabId);
    return "gone";
  }
  if (!(await readsBack(tabId, request, result === "accept" ? "allow" : "block", deadline))) return "unknown";
  if (pageOf(tabId).permission?.id === request.id) answered(tabId, request, result);
  return "confirmed";
}

export const queuedPermissions = (tabId: string) => queues.get(tabId)?.length ?? 0;

export const ONE_TIME_KINDS: ReadonlySet<PermissionKind> = new Set(["camera", "microphone", "cameraPanTiltZoom", "location"]);

export const answersJustOnce = (kinds: readonly PermissionKind[]) => kinds.length > 0 && kinds.every((kind) => ONE_TIME_KINDS.has(kind));

export function dismissPermissions(tabId: string) {
  for (const [id, entry] of [...deciding]) {
    if (entry.tabId !== tabId) continue;
    deciding.delete(id);
    entry.controller.abort();
    void resolvePermission(id, "dismiss");
  }
  for (const r of queues.get(tabId) ?? []) void resolvePermission(r.id, "dismiss");
  queues.delete(tabId);
  const current = pageOf(tabId).permission;
  if (current) {
    void resolvePermission(current.id, "dismiss");
    patchPage(tabId, { permission: null });
  }
}

type Describe = { icon: string; noun?: string; question?: (site: string) => string };

const KINDS: Record<PermissionKind, Describe> = {
  camera: { icon: "video", noun: "camera" },
  microphone: { icon: "mic", noun: "microphone" },
  cameraPanTiltZoom: { icon: "video", noun: "camera's pan, tilt and zoom" },
  screen: { icon: "rectangle.on.rectangle", question: (s) => `Allow ${s} to share your screen?` },
  location: { icon: "location", noun: "location" },
  notifications: { icon: "bell", question: (s) => `Allow ${s} to send you notifications?` },
  clipboard: { icon: "doc.on.clipboard", noun: "clipboard" },
  midi: { icon: "pianokeys", noun: "MIDI devices" },
  multipleDownloads: { icon: "arrow.down.circle", question: (s) => `Allow ${s} to download multiple files?` },
  localFonts: { icon: "textformat", noun: "fonts" },
  idleDetection: { icon: "person.crop.circle.badge.clock", question: (s) => `Allow ${s} to know when you're actively using this device?` },
  storageAccess: { icon: "externaldrive", question: (s) => `Allow ${s} to use cookies and site data while embedded?` },
  diskQuota: { icon: "internaldrive", question: (s) => `Allow ${s} to store files on your device?` },
  windowManagement: { icon: "macwindow.on.rectangle", noun: "displays to open and place windows" },
  fileSystem: { icon: "folder", noun: "files" },
  keyboardLock: { icon: "keyboard", noun: "keyboard" },
  pointerLock: { icon: "cursorarrow", noun: "mouse pointer" },
  protectedMedia: { icon: "lock.shield", question: (s) => `Allow ${s} to play protected content?` },
  protocolHandler: { icon: "envelope", question: (s) => `Make ${s} your default mail app?` },
  sensors: { icon: "gyroscope", noun: "motion sensors" },
  localNetwork: { icon: "network", noun: "devices on your local network" },
  vr: { icon: "visionpro", noun: "virtual reality devices" },
  ar: { icon: "visionpro", noun: "augmented reality data" },
  handTracking: { icon: "hand.raised", noun: "hand tracking" },
  identityProvider: { icon: "person.badge.key", question: (s) => `Allow ${s} to sign you in with an identity provider?` },
  webAppInstallation: { icon: "app.badge", question: (s) => `Allow ${s} to install web apps?` },
  capturedSurfaceControl: { icon: "rectangle.on.rectangle", question: (s) => `Allow ${s} to scroll and zoom the tab you share?` },
};

const list = (words: string[]) => (words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

export function describePermission(request: PermissionRequest): { icons: string[]; question: string } {
  const site = originForSecurityDisplay(request.origin);
  const kinds = request.permissions.map((k) => KINDS[k] ?? { icon: "questionmark.circle", noun: k });
  const icons = [...new Set(kinds.map((k) => k.icon))];
  const single = kinds.length === 1 ? kinds[0]!.question : undefined;
  if (single) return { icons, question: single(site) };
  const nouns = kinds.map((k) => k.noun).filter((n): n is string => !!n);
  if (nouns.length === kinds.length) return { icons, question: `Allow ${site} to access your ${list(nouns)}?` };
  return { icons, question: `Allow ${site} to use ${list(request.permissions.map((k) => KINDS[k]?.noun ?? k))}?` };
}
