import { isSharing, onConsentPeriodChange, type ConsentToken } from "./choice";
import { countFor } from "./countFor";

let inWebKit = 0;

export function noteTabSwitcherOpenedInWebKit() {
  inWebKit++;
}

export function takeTabSwitcherOpensInWebKit(): number {
  const taken = inWebKit;
  inWebKit = 0;
  return taken;
}

let rowCloses = 0;

export function noteTabSwitcherRowClosed(consent?: ConsentToken | null) {
  countFor(consent, () => void rowCloses++, { tab_switcher_row_closes: 1 });
}

export function takeTabSwitcherRowCloses(): number {
  const taken = rowCloses;
  rowCloses = 0;
  return taken;
}

let menuReleases = 0;

onConsentPeriodChange(() => (menuReleases = 0));

export function noteTabSwitcherReleasedInMenu() {
  if (isSharing()) menuReleases++;
}

export function takeTabSwitcherMenuReleases(): number {
  const taken = menuReleases;
  menuReleases = 0;
  return taken;
}
