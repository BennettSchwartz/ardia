import { applePasswordsAvailable } from "../../platform/passwords";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { DEFAULT_SETTINGS, type PasswordManager, type Settings } from "../settings/settings";
import type { Profile } from "../browser/types";
import { incognitoOriginal, isIncognitoProfile } from "../browser/model";

const PASSWORD_MANAGERS: readonly PasswordManager[] = ["apple", "ardia", "none"];

const isPasswordManager = (value: unknown): value is PasswordManager => PASSWORD_MANAGERS.includes(value as PasswordManager);

export function effectivePasswordManager(settings: Pick<Settings, "passwordManager">, profile?: Pick<Profile, "passwordManager">): PasswordManager {
  if (!PLATFORM_FEATURES.applePasswords) return "ardia";
  const own = profile?.passwordManager;
  const chosen = isPasswordManager(own) ? own : isPasswordManager(settings.passwordManager) ? settings.passwordManager : DEFAULT_SETTINGS.passwordManager;
  return chosen === "apple" && !applePasswordsAvailable() ? "ardia" : chosen;
}

export const regularProfileId = (profileId: string) => (isIncognitoProfile(profileId) ? incognitoOriginal(profileId) : profileId);

type ChoiceState = { settings: Pick<Settings, "passwordManager">; profiles: Record<string, Profile | undefined> };

const dataOf = (profile: Pick<Profile, "id" | "dataId">) => profile.dataId ?? profile.id;

export function profilesSharingData(s: ChoiceState, profileId: string): string[] {
  const own = s.profiles[regularProfileId(profileId)];
  if (!own) return [];
  const data = dataOf(own);
  const order = [data, ...Object.keys(s.profiles).sort()];
  return [...new Set(order)].filter((id) => s.profiles[id] && dataOf(s.profiles[id]!) === data);
}

export function sharedPasswordManagerChoice(s: ChoiceState, profileId: string): PasswordManager | undefined {
  return profilesSharingData(s, profileId)
    .map((id) => s.profiles[id]!.passwordManager)
    .find(isPasswordManager);
}

export function profilePasswordManager(s: ChoiceState, profileId: string): PasswordManager {
  return effectivePasswordManager(s.settings, { passwordManager: sharedPasswordManagerChoice(s, profileId) });
}

export function passwordManagerProfileCounts(s: ChoiceState): Record<string, string> {
  const counts: Record<PasswordManager, number> = { apple: 0, ardia: 0, none: 0 };
  for (const id of Object.keys(s.profiles)) counts[profilePasswordManager(s, id)]++;
  return { password_manager_profiles_apple: String(counts.apple), password_manager_profiles_ardia: String(counts.ardia), password_manager_profiles_none: String(counts.none) };
}
