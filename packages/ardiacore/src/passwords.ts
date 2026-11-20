import { decodeReply } from "./engine/call";
import { nativeModule } from "./nativeModules";

export type SavedPassword = { origin: string; username: string; created: number; modified: number };
export type PasswordExportStatus = "succeeded" | "cancelled" | "writeFailed" | "reauthFailed" | "inProgress";
export type FieldProviderField = "login" | "oneTimeCode";
export type FieldProviderProfile = { profile: string; fields: FieldProviderField[]; codeSetup: boolean };
export type PasskeyProviderProfile = { profile: string; group: string; create: boolean };
export type PasskeyImportState = { phase?: "received" | "copying" | "done" | "failed" | "cancelled"; at?: number; group?: string; kept?: number; existing?: number; skipped?: number };
export type PasskeyAction = "use" | "save" | "excludedOk" | "other" | "cancel";
export type StoredPasskey = { rpId: string; credentialId: string; userName: string; userDisplayName: string; created: number; source: "apple" | "ardia" };
export type PasskeyRequestEvent = {
  id: string;
  kind: "get" | "create" | "excluded";
  site: string;
  host: string;
  accounts: { name: string; displayName: string; source: "apple" | "ardia" }[];
  userName: string;
};
export type SystemPanelRefusal = "noTab" | "noProvider" | "stale" | "hidden" | "notFocused" | "unavailable" | "notKey" | "notEditing" | "throttled" | "refused" | "noPanel" | "tabGone";
export type SystemPanelResult = { shown: boolean; reason?: SystemPanelRefusal };
export type VerificationCodeRefusal = "noTab" | "unknownToken" | "stale" | "navigated" | "noProvider" | "frameGone" | "handlerChanged" | "failed";
export type VerificationCodeSetupResult = { opened: boolean; reason?: VerificationCodeRefusal };

const Passwords = nativeModule("ArdiaPasswords");

export const savePassword = async (profile: string, origin: string, username: string, password: string) =>
  !!(await decodeReply<{ ok: true }>(Passwords.save(profile, origin, username, password)));
export const updatePassword = async (profile: string, origin: string, username: string, changes: { username?: string; password?: string }) =>
  !!(await decodeReply<{ ok: true }>(Passwords.update(profile, origin, username, changes.username ?? null, changes.password ?? null)));
