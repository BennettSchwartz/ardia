import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { deleteAllPasskeys, passkeyImportState, passkeySetupState, startPasskeyImport, storedPasskeys, turnOnPasskeyAutofill, type PasskeyImportState } from "../../platform/passwordProviders";
import { useBrowser } from "../browser/store";
import { currentManagerPlugins, useManagerPlugins } from "./passwordManager";
import { passkeyProviderSet, type PasskeyProviderEntry } from "./passwordManagerChoice";

export type PasskeyGroupCount = { group: string; name: string; count: number };
export type PasskeySetup = { available: boolean; reason?: "macOS" | "helper"; autofillEnabled?: boolean | null };

export const passkeyGroups = (): PasskeyProviderEntry[] => passkeyProviderSet(useBrowser.getState(), currentManagerPlugins());

export function usePasskeyGroups(): PasskeyProviderEntry[] {
  const plugins = useManagerPlugins();
  const profiles = useBrowser((s) => s.profiles);
  const [groups, setGroups] = useState<PasskeyProviderEntry[]>(() => passkeyProviderSet(useBrowser.getState(), plugins));
  useEffect(() => setGroups(passkeyProviderSet(useBrowser.getState(), plugins)), [plugins, profiles]);
  return groups;
}

export async function countPasskeys(groups: readonly PasskeyProviderEntry[]): Promise<PasskeyGroupCount[]> {
  const counts = await Promise.all(groups.map((g) => storedPasskeys(g.group).then((r) => r?.passkeys?.length ?? 0).catch(() => 0)));
  return groups.map((g, i) => ({ group: g.group, name: g.groupName, count: counts[i] ?? 0 }));
}

export function usePasskeyCounts(groups: readonly PasskeyProviderEntry[], refreshKey: number): PasskeyGroupCount[] | null {
  const [counts, setCounts] = useState<PasskeyGroupCount[] | null>(null);
  const key = groups.map((g) => `${g.group}:${g.groupName}`).join("|");
  useEffect(() => {
    let live = true;
    const refresh = () => void countPasskeys(groups).then((next) => live && setCounts(next));
    refresh();
    const watch = AppState.addEventListener("change", (state) => state === "active" && refresh());
    return () => {
      live = false;
      watch.remove();
    };
  }, [key, refreshKey]);
  return counts;
}

export function passkeyCountText(counts: readonly PasskeyGroupCount[]): string {
  const held = counts.filter((c) => c.count > 0);
  if (!held.length) return "";
  const word = (n: number) => (n === 1 ? "1 passkey" : `${n} passkeys`);
  if (held.length === 1) return `${word(held[0]!.count)} in ${held[0]!.name}`;
  return held.map((c, i) => (i === 0 ? `${word(c.count)} in ${c.name}` : `${c.count} in ${c.name}`)).join(", ");
}

export async function removeAllPasskeys(groups: readonly PasskeyProviderEntry[]): Promise<number> {
  const removed = await Promise.all(groups.map((g) => deleteAllPasskeys(g.group).then((r) => r?.deleted ?? 0).catch(() => 0)));
  return removed.reduce((a, b) => a + b, 0);
}

export const readPasskeySetup = (): Promise<PasskeySetup> => passkeySetupState().catch(() => ({ available: false }) as PasskeySetup);
export const openPasswordsForImport = () => startPasskeyImport().then((r) => r?.opened === true).catch(() => false);
export const askToTurnOnPasskeyAutofill = (settings = false) => turnOnPasskeyAutofill(settings).catch(() => null);

export function usePasskeyImportState(since: number, watching: boolean): PasskeyImportState {
  const [state, setState] = useState<PasskeyImportState>({});
  useEffect(() => {
    if (!watching) return;
    let live = true;
    const poll = () =>
      void passkeyImportState()
        .catch(() => ({}) as PasskeyImportState)
        .then((next) => live && setState(next && (next.at ?? 0) >= since ? next : {}));
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [since, watching]);
  return state;
}
