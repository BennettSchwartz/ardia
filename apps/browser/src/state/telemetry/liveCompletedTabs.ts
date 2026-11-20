import { isSharing, onConsentPeriodChange } from "./choice";

let closed = 0;

export function noteLiveCompletedTabsClosed(n: number) {
  if (isSharing()) closed += n;
}

export function takeLiveCompletedTabsClosed() {
  const taken = closed;
  closed = 0;
  return taken;
}

onConsentPeriodChange(() => void takeLiveCompletedTabsClosed());
