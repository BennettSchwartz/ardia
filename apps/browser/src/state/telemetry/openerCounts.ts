let switches = 0;
let links = 0;

export function noteOpenersKeptInOtherProfiles(kept: number) {
  if (kept <= 0) return;
  switches++;
  links += kept;
}

export function takeOpenerCounts() {
  const taken = { opener_switches_kept_other_profiles: switches, opener_links_kept_other_profiles: links };
  switches = 0;
  links = 0;
  return taken;
}
