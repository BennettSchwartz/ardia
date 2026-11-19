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

export const profilePasswordManager = (s: { settings: Pick<Settings, "passwordManager">; profiles: Record<string, Profile | undefined> }, profileId: string): PasswordManager =>
  effectivePasswordManager(s.settings, s.profiles[regularProfileId(profileId)]);

export function passwordManagerProfileCounts(s: { settings: Pick<Settings, "passwordManager">; profiles: Record<string, Profile | undefined> }): Record<string, string> {
  const counts: Record<PasswordManager, number> = { apple: 0, ardia: 0, none: 0 };
  for (const id of Object.keys(s.profiles)) counts[profilePasswordManager(s, id)]++;
  return { password_manager_profiles_apple: String(counts.apple), password_manager_profiles_ardia: String(counts.ardia), password_manager_profiles_none: String(counts.none) };
}
