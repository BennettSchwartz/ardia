import { isSharing, onConsentPeriodChange } from "./choice";

let settles = 0;
let settlesWithoutSwitch = 0;
let dotReorders = 0;

export function notePagerSettle(switched: boolean) {
  if (!isSharing()) return;
  settles++;
  if (!switched) settlesWithoutSwitch++;
}

export const noteProfileDotReorder = () => void (isSharing() && dotReorders++);

export function takePagerCounts() {
  const taken = { profile_pager_settles: settles, profile_pager_settles_without_switch: settlesWithoutSwitch, profile_dot_reorders: dotReorders };
  settles = 0;
  settlesWithoutSwitch = 0;
  dotReorders = 0;
  return taken;
}

onConsentPeriodChange(() => void takePagerCounts());
