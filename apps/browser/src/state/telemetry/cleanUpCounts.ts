import { isSharing, onConsentPeriodChange } from "./choice";

const NO_COUNTS = { clean_up_auto_tabs: 0, clean_up_auto_hidden_profile_tabs: 0 };
let counts = { ...NO_COUNTS };

export function noteAutoCleanUp(tabs: number, hiddenProfileTabs: number) {
  if (!isSharing()) return;
  counts.clean_up_auto_tabs += tabs;
  counts.clean_up_auto_hidden_profile_tabs += hiddenProfileTabs;
}

export function takeCleanUpCounts() {
  const taken = counts;
  counts = { ...NO_COUNTS };
  return taken;
}

onConsentPeriodChange(() => void takeCleanUpCounts());
