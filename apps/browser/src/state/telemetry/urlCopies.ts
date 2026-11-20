import { isSharing, onConsentPeriodChange } from "./choice";

let copies = 0;
let whilePending = 0;
let selectedTabs = 0;

export function noteSelectedTabUrlsCopied() {
  if (!isSharing()) return;
  copies++;
  selectedTabs++;
}

export function noteUrlCopied(firstPagePending: boolean) {
  if (!isSharing()) return;
  copies++;
  if (firstPagePending) whilePending++;
}

export function takeUrlCopyCounts() {
  const taken = { url_copies: copies, url_copies_while_pending: whilePending, url_copies_of_selected_tabs: selectedTabs };
  copies = 0;
  whilePending = 0;
  selectedTabs = 0;
  return taken;
}

onConsentPeriodChange(() => void takeUrlCopyCounts());
