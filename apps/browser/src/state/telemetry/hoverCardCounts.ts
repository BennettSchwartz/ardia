import { isSharing, onConsentPeriodChange, type ConsentToken } from "./choice";
import { countFor } from "./countFor";

const NONE = { tab_hover_cards_shown: 0, tab_hover_card_presses: 0, tab_hover_card_resets: 0, tab_menu_pinned_resets: 0 };
let counts = { ...NONE };

export const noteTabHoverCardShown = (consent?: ConsentToken | null) => countFor(consent, () => void counts.tab_hover_cards_shown++, { tab_hover_cards_shown: 1 }, "tab_presses");

export function noteTabHoverCardPress(reset: boolean) {
  if (!isSharing()) return;
  counts.tab_hover_card_presses++;
  if (reset) counts.tab_hover_card_resets++;
}

export const noteTabMenuPinnedReset = () => void (isSharing() && counts.tab_menu_pinned_resets++);

export function takeHoverCardCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}

onConsentPeriodChange(() => void takeHoverCardCounts());
