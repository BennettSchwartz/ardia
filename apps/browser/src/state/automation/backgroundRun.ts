import type { BrowserCommand } from "../../platform/commands";

export const BACKGROUND_RUN_COMMANDS: ReadonlySet<BrowserCommand> = new Set<BrowserCommand>([
  "toggleSidebar",
  "toggleTabLayout",
  "nextTab",
  "previousTab",
  "selectLastTab",
  "togglePin",
  "toggleMute",
  "moveTabUp",
  "moveTabDown",
  "stop",
]);
