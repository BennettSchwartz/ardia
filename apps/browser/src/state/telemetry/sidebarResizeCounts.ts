import { takeSidebarScrollCounts } from "./sidebarScrollCounts";
import { isSharing, onConsentPeriodChange } from "./choice";

let resizes = 0;

export function noteSidebarResize() {
  if (isSharing()) resizes++;
}

export function takeSidebarResizeCounts() {
  const taken = { sidebar_resizes: resizes, ...takeSidebarScrollCounts() };
  resizes = 0;
  return taken;
}

onConsentPeriodChange(() => void takeSidebarResizeCounts());
