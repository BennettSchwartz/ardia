import { registerSocketMethods } from "./socketCatalog";
import { DOWNLOAD_METHODS } from "./socketDownloads";
import { LIBRARY_METHODS } from "./socketLibrary";
import { MISC_METHODS } from "./socketMisc";
import { SITE_METHODS } from "./socketSites";
import { SETTINGS_METHODS } from "./socketSettings";
import { PROFILE_METHODS } from "./socketProfiles";
import { SPLIT_METHODS } from "./socketSplits";
import { TAB_METHODS } from "./socketTabs";
import { WINDOW_METHODS } from "./socketWindows";
import { PROMPT_METHODS } from "./socketPrompts";
import { SURFACE_METHODS } from "./socketSurfaces";

let registered = false;

export function registerSocketAreas() {
  if (registered) return;
  registered = true;
  registerSocketMethods([...TAB_METHODS, ...WINDOW_METHODS, ...PROFILE_METHODS, ...SPLIT_METHODS, ...LIBRARY_METHODS, ...DOWNLOAD_METHODS, ...SETTINGS_METHODS, ...SITE_METHODS, ...MISC_METHODS, ...PROMPT_METHODS, ...SURFACE_METHODS]);
}
