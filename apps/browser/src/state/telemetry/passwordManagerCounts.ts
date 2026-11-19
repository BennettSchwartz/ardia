import type { PasswordManager } from "../settings/settings";
import type { ConsentToken } from "./choice";
import { countFor } from "./countFor";

export type ApplePasswordsOpener = "key" | "menu";
export type VerificationCodeStep = "offered" | "setUp" | "failed";

const PANEL_FIELDS: Record<ApplePasswordsOpener, [shown: string, refused: string]> = {
  key: ["apple_passwords_key_opens", "apple_passwords_key_refused"],
  menu: ["apple_passwords_menu_opens", "apple_passwords_menu_refused"],
};

const CODE_FIELDS: Record<VerificationCodeStep, string> = {
  offered: "verification_code_setups_offered",
  setUp: "verification_code_setups_accepted",
  failed: "verification_code_setups_failed",
};

const CHOICE_FIELDS: Record<PasswordManager, string> = {
  apple: "password_manager_chose_apple",
  ardia: "password_manager_chose_ardia",
  none: "password_manager_chose_none",
};

const FIELDS = [...Object.values(PANEL_FIELDS).flat(), ...Object.values(CODE_FIELDS), ...Object.values(CHOICE_FIELDS)];

let counts: Record<string, number> = {};
const bump = (field: string, consent?: ConsentToken | null) => countFor(consent, () => void (counts[field] = (counts[field] ?? 0) + 1), { [field]: 1 });

export const noteApplePasswordsPanel = (opener: ApplePasswordsOpener, shown: boolean) => bump(PANEL_FIELDS[opener][shown ? 0 : 1]);

export const noteVerificationCodeSetup = (step: VerificationCodeStep, consent?: ConsentToken | null) => bump(CODE_FIELDS[step], consent);

export const notePasswordManagerChosen = (manager: PasswordManager) => bump(CHOICE_FIELDS[manager]);

export function takePasswordManagerCounts(): Record<string, number> {
  const taken = Object.fromEntries(FIELDS.map((field) => [field, counts[field] ?? 0]));
  counts = {};
  return taken;
}
