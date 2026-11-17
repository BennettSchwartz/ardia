import { onExtensionInstallPrompt, onExtensionsChanged } from "../../platform/extensions";
import { capture, consentToken, type ConsentToken } from "./client";

const EXTENSION_SETTLE_MS = 20_000;
const MAX_PROMPTED = 50;
const prompted = new Map<string, ConsentToken | null>();
let watching = false;

export function watchExtensionInstalls(startedAt: number) {
  if (watching) return;
  watching = true;
  onExtensionInstallPrompt((prompt) => {
    prompted.delete(prompt.id);
    prompted.set(prompt.id, consentToken());
    if (prompted.size > MAX_PROMPTED) prompted.delete(prompted.keys().next().value!);
  });
  onExtensionsChanged((e) => {
    if (e.event !== "installed") return;
    const consent = prompted.get(e.id) ?? null;
    prompted.delete(e.id);
    if (Date.now() - startedAt > EXTENSION_SETTLE_MS) capture("extension_installed", {}, consent);
  });
}
