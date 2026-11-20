import { call, type FieldProviderHint, type FieldProviderOpened, type FieldProviderProfile, type PasskeyRequestEvent, type VerificationCodeFound } from "@ardia/ardiacore";

export type { FieldProviderHint, FieldProviderOpened, PasskeyRequestEvent, VerificationCodeFound };
export type FieldProvider = FieldProviderProfile;

const PROVIDER_SESSION = Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0")).join("");

export async function setFieldProviders(generation: number, profiles: FieldProvider[]): Promise<{ applied: boolean; answered: boolean }> {
  const reply: { applied?: unknown } | null = await call("passwords.setFieldProviders", { generation, profiles, session: PROVIDER_SESSION });
  return { applied: reply?.applied === true, answered: typeof reply?.applied === "boolean" };
}
export const setPasskeyProviders = (generation: number, providers: { profile: string; group: string; groupName: string; create: boolean }[]) =>
  call("passwords.setPasskeyProviders", { generation, providers });
export const resolvePasskey = (id: string, action: "use" | "save" | "excludedOk" | "other" | "cancel", account?: number) =>
  call("passwords.resolvePasskey", account === undefined ? { id, action } : { id, action, account });
export const showSystemPanel = (tab: string, generation: number) => call("passwords.showSystemPanel", { tab, generation });
export const showPanelHint = (tab: string, label: string, side: "above" | "below") => call("passwords.showPanelHint", { tab, label, side });
export const systemPanelAvailable = () => call("passwords.systemPanelAvailable", {});
export const otpauthHandler = () => call("passwords.otpauthHandler", {});
export const setUpVerificationCode = (tab: string, token: string, generation: number) => call("passwords.setUpVerificationCode", { tab, token, generation });
