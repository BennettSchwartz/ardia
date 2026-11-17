export type ExtensionActionAnswer = "popup" | "sidePanel" | "none" | "menu";

const counts: Record<ExtensionActionAnswer, number> = { popup: 0, sidePanel: 0, none: 0, menu: 0 };

export const noteExtensionAction = (answer: ExtensionActionAnswer) => void counts[answer]++;

export function takeExtensionActionCounts() {
  const taken = { extension_action_popups: counts.popup, extension_action_side_panels: counts.sidePanel, extension_action_nothing: counts.none, extension_action_menus: counts.menu };
  counts.popup = counts.sidePanel = counts.none = counts.menu = 0;
  return taken;
}
