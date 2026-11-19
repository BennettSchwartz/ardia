import { confirm } from "../../platform/dialogs";
import type { CloseAsk } from "../windows/windowClose";
import { lastFocusedEligibleWindow } from "./automationWindows";
import { now } from "./socketTargets";
import { OpError } from "./workspaceTargets";

export const UNSEEN = "Ardia would have to ask first, and nobody can see that question here (its window isn't on screen, or Ardia runs in the background)";

export function askWhereSeen(outcome: string): CloseAsk {
  return async (options) => {
    const answer = await confirm({ ...options, onlyIfShown: true });
    if (answer.unshown) throw new OpError("refused", `${outcome}: ${UNSEEN}.`);
    return answer;
  };
}

export const shownWindowId = (): string | undefined => lastFocusedEligibleWindow(now()) ?? undefined;
