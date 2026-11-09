import { applePasswordsAvailable } from "../../platform/passwords";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { DEFAULT_SETTINGS, type PasswordManager, type Settings } from "../settings/settings";

const PASSWORD_MANAGERS: readonly PasswordManager[] = ["apple", "ardia", "none"];

function chosenPasswordManager(settings: Pick<Settings, "passwordManager">): PasswordManager {
  return PASSWORD_MANAGERS.includes(settings.passwordManager) ? settings.passwordManager : DEFAULT_SETTINGS.passwordManager;
}

export function effectivePasswordManager(settings: Pick<Settings, "passwordManager">): PasswordManager {
  if (!PLATFORM_FEATURES.applePasswords) return "ardia";
  const chosen = chosenPasswordManager(settings);
  return chosen === "apple" && !applePasswordsAvailable() ? "ardia" : chosen;
}
