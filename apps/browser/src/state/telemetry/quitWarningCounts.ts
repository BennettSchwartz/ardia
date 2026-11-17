let asked = 0;
let cancelled = 0;
let askedWithDownloads = 0;
let cancelledWithDownloads = 0;

export function noteQuitAskedAfterTabsConfirm(wasCancelled: boolean) {
  asked++;
  if (wasCancelled) cancelled++;
}

export function noteQuitAskedWithDownloads(wasCancelled: boolean) {
  askedWithDownloads++;
  if (wasCancelled) cancelledWithDownloads++;
}

export function takeQuitWarningCounts() {
  const taken = { quit_warnings_after_tabs_confirm: asked, quit_warnings_after_tabs_confirm_cancelled: cancelled, quit_warnings_with_downloads: askedWithDownloads, quit_warnings_with_downloads_cancelled: cancelledWithDownloads };
  asked = cancelled = askedWithDownloads = cancelledWithDownloads = 0;
  return taken;
}
