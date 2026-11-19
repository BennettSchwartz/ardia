import { registerSocketMethods } from "./socketCatalog";
import { PROFILE_METHODS } from "./socketProfiles";
import { SPLIT_METHODS } from "./socketSplits";
import { TAB_METHODS } from "./socketTabs";
import { WINDOW_METHODS } from "./socketWindows";

let registered = false;

export function registerSocketAreas() {
  if (registered) return;
  registered = true;
  registerSocketMethods([...TAB_METHODS, ...WINDOW_METHODS, ...PROFILE_METHODS, ...SPLIT_METHODS]);
}
