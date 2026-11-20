import { isSharing, onConsentPeriodChange } from "./choice";

let chosen = 0;

export function noteAutoHideTabsChosen() {
  if (isSharing()) chosen++;
}

export function takeAutoHideTabsChoices(): number {
  const taken = chosen;
  chosen = 0;
  return taken;
}

let tornOffKept = 0;

export function noteTornOffWindowKeptAutoHide() {
  if (isSharing()) tornOffKept++;
}

export function takeTornOffWindowsKeptAutoHide(): number {
  const taken = tornOffKept;
  tornOffKept = 0;
  return taken;
}

onConsentPeriodChange(() => void takeAutoHideTabsChoices());

onConsentPeriodChange(() => void takeTornOffWindowsKeptAutoHide());
