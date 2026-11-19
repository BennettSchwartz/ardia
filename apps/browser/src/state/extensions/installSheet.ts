import { chooseExtensionFolder, discardStagedExtension, inspectUnpackedExtension, installExtension, resolveExtensionInstallPrompt, type ExtensionInstallPrompt } from "../../platform/extensions";
import { useBrowser } from "../browser/store";
import { errorText } from "../../lib/errors";
import { noteUnpackedInstall } from "../telemetry/exportCounts";
import { consentToken } from "../telemetry/client";
import { noteExtensionInstallPromptStale } from "../telemetry/usage";
import { refreshExtensions, refreshExtensionsAfterChange } from "./lists";
import { extensionProfile, nextInstallKey, useExtensions, type InstallRequest } from "./store";

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

const STALE_PROMPT = "This install request has closed. Open the extension's page in the Chrome Web Store and add it again.";

const declinePrompt = (prompt: ExtensionInstallPrompt) => void resolveExtensionInstallPrompt(prompt, false).catch(() => {});

let waitingPrompt: { windowId: string; prompt: ExtensionInstallPrompt } | null = null;

function retire(request: InstallRequest, outcome: InstallOutcome) {
  if (request.status === "prompt") declinePrompt(request.prompt);
  if (request.status === "ready") discardStagedExtension(request.pkg);
  if (request.status !== "error") settle(request.key, outcome);
}

export function showInstallSheet(next: InstallRequest): boolean {
  const current = useExtensions.getState().install;
  if (current?.status === "installing") {
    if (next.status === "ready") discardStagedExtension(next.pkg);
    return false;
  }
  if (current) retire(current, { cancelled: true });
  useExtensions.setState({ install: next });
  return true;
}

function showWaitingPrompt() {
  const waiting = waitingPrompt;
  if (!waiting || useExtensions.getState().install) return;
  waitingPrompt = null;
  showInstallSheet({ key: nextInstallKey(), windowId: waiting.windowId, profile: waiting.prompt.profile, source: "webStore", status: "prompt", prompt: waiting.prompt });
}

export function showInstallPrompt(windowId: string, prompt: ExtensionInstallPrompt) {
  if (useExtensions.getState().install?.status === "installing") {
    if (waitingPrompt) declinePrompt(waitingPrompt.prompt);
    waitingPrompt = { windowId, prompt };
    return;
  }
  showInstallSheet({ key: nextInstallKey(), windowId, profile: prompt.profile, source: "webStore", status: "prompt", prompt });
}

export async function loadUnpacked(windowId: string, profile = extensionProfile(useBrowser.getState(), windowId)): Promise<boolean> {
  const path = await chooseExtensionFolder();
  if (!path) return false;
  try {
    const pkg = await inspectUnpackedExtension(path);
    showInstallSheet({ key: nextInstallKey(), windowId, profile, source: "unpacked", status: "ready", pkg });
  } catch (error) {
    showInstallSheet({ key: nextInstallKey(), windowId, profile, source: "unpacked", status: "error", error: errorText(error) });
  }
  return true;
}

const ownRequest = (key?: number) => {
  const request = useExtensions.getState().install;
  return request && (key === undefined || request.key === key) ? request : null;
};

function failSheet(request: InstallRequest, error: string) {
  const shown = useExtensions.getState().install?.key === request.key;
  if (!shown) return;
  const failed: InstallRequest = { key: request.key, windowId: request.windowId, profile: request.profile, source: request.source, status: "error", error };
  useExtensions.setState({ install: useBrowser.getState().windows[request.windowId] ? failed : null });
  showWaitingPrompt();
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
  for (const ms of [1500, 5000]) setTimeout(() => void refreshExtensions(request.profile), ms);
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
  const consent = consentToken();
  useExtensions.setState({ install: { ...request, status: "installing" } });
  let id: string;
  try {
    id = await installExtension(request.pkg, request.profile);
  } catch (error) {
    settle(request.key, { error: errorText(error) });
    return failSheet(request, errorText(error));
  }
  if (request.source === "unpacked") noteUnpackedInstall(consent);
  if (useExtensions.getState().install?.key === request.key) useExtensions.setState({ install: null });
  settle(request.key, { installed: id });
  showWaitingPrompt();
  await refreshExtensionsAfterChange(request.profile);
}

export function cancelInstall(key?: number) {
  const request = ownRequest(key);
  if (!request || request.status === "installing") return;
  retire(request, { cancelled: true });
  useExtensions.setState({ install: null });
  showWaitingPrompt();
}

export function abandonInstall(key: number, error: string) {
  const request = ownRequest(key);
  if (!request || request.status === "installing") return;
  retire(request, { error });
  useExtensions.setState({ install: null });
  showWaitingPrompt();
}
