import { chooseExtensionFolder, discardStagedExtension, inspectUnpackedExtension, installExtension, resolveExtensionInstallPrompt, type ExtensionInstallPrompt, type ExtensionPackage } from "../../platform/extensions";
import { useBrowser } from "../browser/store";
import { errorText } from "../../lib/errors";
import { isUtilityWindowId } from "../settings/settingsWindows";
import { noteUnpackedInstall } from "../telemetry/exportCounts";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { noteExtensionInstallPromptStale } from "../telemetry/usage";
import { declinePrompt, holdPrompt, takeHeldPrompt } from "./installPrompts";
import { freshExtensions, refreshExtensions, refreshExtensionsAfterChange } from "./lists";
import { extensionProfile, nextInstallKey, useExtensions, type InstallRequest, type InstallReview } from "./store";

export type InstallOutcome = { installed: string } | { error: string } | { cancelled: true };

export type InstallWatch = { check?: () => string | null; settle: (outcome: InstallOutcome) => void };

const watches = new Map<number, InstallWatch>();

export function watchInstall(key: number, watch: InstallWatch): () => void {
  watches.set(key, watch);
  return () => {
    if (watches.get(key) === watch) watches.delete(key);
  };
}

function settle(key: number, outcome: InstallOutcome) {
  const watch = watches.get(key);
  watches.delete(key);
  watch?.settle(outcome);
}

export const installWatchCount = () => watches.size;

export const SHEET_CLOSED = "The window showing the install sheet closed before the user answered.";

const STALE_PROMPT = "This install request has closed. Open the extension's page in the Chrome Web Store and add it again.";

const mounted = new Map<number, number>();

export function sheetMounted(key: number): () => void {
  mounted.set(key, (mounted.get(key) ?? 0) + 1);
  return () => {
    const left = (mounted.get(key) ?? 1) - 1;
    if (left) mounted.set(key, left);
    else mounted.delete(key);
    setTimeout(() => {
      if (!mounted.has(key)) abandonInstall(key, SHEET_CLOSED);
    }, 0);
  };
}

const sheetCanShow = (request: InstallRequest) => (isUtilityWindowId(request.windowId) ? mounted.has(request.key) : !!useBrowser.getState().windows[request.windowId]);

let watchingWindows = false;

function watchSheetWindows() {
  if (watchingWindows) return;
  watchingWindows = true;
  useBrowser.subscribe((s, prev) => {
    if (s.windows === prev.windows) return;
    const request = useExtensions.getState().install;
    if (request && !isUtilityWindowId(request.windowId) && !s.windows[request.windowId]) abandonInstall(request.key, SHEET_CLOSED);
  });
}

function retire(request: InstallRequest, outcome: InstallOutcome) {
  if (request.status === "prompt") declinePrompt(request.prompt);
  if (request.status === "ready") discardStagedExtension(request.pkg);
  if (request.status !== "error") settle(request.key, outcome);
}

export function showInstallSheet(next: InstallRequest): boolean {
  watchSheetWindows();
  const current = useExtensions.getState().install;
  if (current?.status === "installing") {
    if (next.status === "ready") discardStagedExtension(next.pkg);
    return false;
  }
  if (current) retire(current, { cancelled: true });
  useExtensions.setState({ install: next });
  return true;
}

function showHeldPrompt() {
  if (useExtensions.getState().install) return;
  const held = takeHeldPrompt();
  if (held) showInstallSheet({ key: nextInstallKey(), windowId: held.windowId, profile: held.prompt.profile, source: "webStore", status: "prompt", prompt: held.prompt });
}

export function showInstallPrompt(windowId: string, prompt: ExtensionInstallPrompt) {
  if (useExtensions.getState().install?.status === "installing") return holdPrompt(windowId, prompt);
  showInstallSheet({ key: nextInstallKey(), windowId, profile: prompt.profile, source: "webStore", status: "prompt", prompt });
}

export async function reviewOf(pkg: ExtensionPackage, profile: string): Promise<InstallReview> {
  if (!pkg.installId) return {};
  const list = await freshExtensions(profile);
  const same = list.find((x) => x.id === pkg.installId);
  const replaces = same && same.path !== pkg.installPath ? { id: same.id, name: same.name, path: same.managedSource ?? same.path ?? null } : undefined;
  const direct = list.find((x) => x.id !== pkg.installId && !x.managedSource && x.path === pkg.path);
  return { ...(replaces ? { replaces } : {}), ...(direct ? { leaves: { id: direct.id, name: direct.name } } : {}) };
}

export async function stageForReview(windowId: string, profile: string, folder: string): Promise<void> {
  try {
    const pkg = await inspectUnpackedExtension(folder, profile);
    const review = await reviewOf(pkg, profile).catch(() => ({}));
    showInstallSheet({ key: nextInstallKey(), windowId, profile, source: "unpacked", status: "ready", pkg, review });
  } catch (error) {
    showInstallSheet({ key: nextInstallKey(), windowId, profile, source: "unpacked", status: "error", error: errorText(error) });
  }
}

export async function loadUnpacked(windowId: string, profile = extensionProfile(useBrowser.getState(), windowId)): Promise<boolean> {
  const path = await chooseExtensionFolder();
  if (!path) return false;
  await stageForReview(windowId, profile, path);
  return true;
}

const ownRequest = (key?: number) => {
  const request = useExtensions.getState().install;
  return request && (key === undefined || request.key === key) ? request : null;
};

function failSheet(request: InstallRequest, error: string) {
  if (useExtensions.getState().install?.key !== request.key) return;
  const failed: InstallRequest = { key: request.key, windowId: request.windowId, profile: request.profile, source: request.source, status: "error", error };
  useExtensions.setState({ install: sheetCanShow(request) ? failed : null });
  showHeldPrompt();
}

async function acceptPrompt(request: Extract<InstallRequest, { status: "prompt" }>) {
  const consent = consentToken();
  useExtensions.setState({ install: null });
  try {
    await resolveExtensionInstallPrompt(request.prompt, true);
  } catch (error) {
    const stale = (error as { code?: unknown } | null)?.code === "ERR_EXTENSION_PROMPT_STALE";
    if (stale) noteExtensionInstallPromptStale(consent);
    if (useExtensions.getState().install) return;
    useExtensions.setState({ install: { key: request.key, windowId: request.windowId, profile: request.profile, source: request.source, status: "error", error: stale ? STALE_PROMPT : errorText(error) } });
    return;
  }
  for (const ms of [1500, 5000]) setTimeout(() => void refreshExtensions(request.profile, consent), ms);
}

async function addPackage(request: Extract<InstallRequest, { pkg: ExtensionPackage }>, consent: ConsentToken | null) {
  useExtensions.setState({ install: { ...request, status: "installing" } });
  let id: string;
  try {
    id = await installExtension(request.pkg, request.profile);
  } catch (error) {
    discardStagedExtension(request.pkg);
    settle(request.key, { error: errorText(error) });
    return failSheet(request, errorText(error));
  }
  if (request.source === "unpacked") noteUnpackedInstall(consent);
  settle(request.key, { installed: id });
  if (useExtensions.getState().install?.key === request.key) useExtensions.setState({ install: null });
  showHeldPrompt();
  await refreshExtensionsAfterChange(request.profile, consent);
}

export async function confirmInstall(key?: number) {
  const request = ownRequest(key);
  if (request?.status === "prompt") return acceptPrompt(request);
  if (request?.status !== "ready") return;
  const refused = watches.get(request.key)?.check?.() ?? null;
  if (refused) {
    discardStagedExtension(request.pkg);
    settle(request.key, { error: refused });
    return failSheet(request, refused);
  }
  await addPackage(request, consentToken());
}

export function cancelInstall(key?: number) {
  const request = ownRequest(key);
  if (!request || request.status === "installing") return;
  retire(request, { cancelled: true });
  useExtensions.setState({ install: null });
  showHeldPrompt();
}

export function abandonInstall(key: number, error: string) {
  const request = ownRequest(key);
  if (!request || request.status === "installing") return;
  retire(request, { error });
  useExtensions.setState({ install: null });
  showHeldPrompt();
}
