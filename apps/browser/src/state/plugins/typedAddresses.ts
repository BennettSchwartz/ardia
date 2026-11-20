import { isLocalOrigin, switchOrigin } from "../../lib/pluginPageBar";

const TYPED_INTENT_MS = 60_000;
const typed = new Map<string, { origin: string; at: number }>();

export function noteTypedAddress(tabId: string, url: string) {
  const origin = switchOrigin(url);
  if (origin && isLocalOrigin(origin)) typed.set(tabId, { origin, at: Date.now() });
  else typed.delete(tabId);
}

export const dropTypedAddress = (tabId: string) => void typed.delete(tabId);

export function takeTypedAddress(tabId: string, committedUrl: string, committedAt: number, now = Date.now()): string | null {
  const intent = typed.get(tabId);
  if (!intent) return null;
  typed.delete(tabId);
  if (now - intent.at > TYPED_INTENT_MS || (committedAt > 0 && committedAt < intent.at) || switchOrigin(committedUrl) !== intent.origin) return null;
  return intent.origin;
}
