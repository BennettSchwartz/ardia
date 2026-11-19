import { listExtensions, type InstalledExtension } from "../../platform/extensions";
import { useBrowser } from "../browser/store";
import { engineProfiles } from "../profiles/engineProfiles";
import { consentToken } from "../telemetry/client";
import { warnFor } from "../telemetry/logs";
import { useExtensions } from "./store";

const EMPTY: InstalledExtension[] = [];

const loading = new Map<string, Promise<InstalledExtension[]>>();

export function refreshExtensions(profile: string): Promise<InstalledExtension[]> {
  if (!engineProfiles(useBrowser.getState()).includes(profile)) return Promise.resolve(useExtensions.getState().lists[profile] ?? EMPTY);
  const running = loading.get(profile);
  if (running) return running;
  const consent = consentToken();
  const job = listExtensions(profile)
    .then((list) => {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      useExtensions.setState((e) => ({ lists: { ...e.lists, [profile]: list } }));
      return list;
    })
    .catch((error) => {
      warnFor(consent, "[extensions] list failed", error);
      return useExtensions.getState().lists[profile] ?? EMPTY;
    })
    .finally(() => loading.delete(profile));
  loading.set(profile, job);
  return job;
}

const trailing = new Map<string, Promise<InstalledExtension[]>>();

export function refreshExtensionsAfterChange(profile: string): Promise<InstalledExtension[]> {
  const running = loading.get(profile);
  if (!running) return refreshExtensions(profile);
  let next = trailing.get(profile);
  if (!next) {
    next = running.then(() => {
      trailing.delete(profile);
      return refreshExtensions(profile);
    });
    trailing.set(profile, next);
  }
  return next;
}

export const findExtension = (profile: string, id: string) => useExtensions.getState().lists[profile]?.find((x) => x.id === id);
