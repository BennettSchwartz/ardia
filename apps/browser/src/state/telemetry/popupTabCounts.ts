import { isSharing, onConsentPeriodChange } from "./choice";

let popupsOpenedAsTabs = 0;
let shiftClickWindowPeeks = 0;

export function notePopupOpenedAsTab() {
  if (isSharing()) popupsOpenedAsTabs++;
}

export function notePeekFromShiftWindow() {
  if (isSharing()) shiftClickWindowPeeks++;
}

export function takePopupTabCounts() {
  const taken = { popups_opened_as_tabs: popupsOpenedAsTabs, shift_click_window_peeks: shiftClickWindowPeeks };
  popupsOpenedAsTabs = 0;
  shiftClickWindowPeeks = 0;
  return taken;
}

onConsentPeriodChange(() => void takePopupTabCounts());
