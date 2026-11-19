import type { BrowserCommand } from "../../platform/commands";

export const BACKGROUND_RUN_COMMANDS: ReadonlySet<BrowserCommand> = new Set<BrowserCommand>([
  "newTab",
  "newWindow",
  "reopenClosedTab",
  "toggleSidebar",
  "toggleTabLayout",
  "nextTab",
  "previousTab",
  "selectLastTab",
  "togglePin",
  "duplicateTab",
  "toggleMute",
  "moveTabUp",
  "moveTabDown",
  "stop",
]);
