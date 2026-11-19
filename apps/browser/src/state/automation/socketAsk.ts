import { confirm, dismissShownOnlyDialogs } from "../../platform/dialogs";
import type { CloseAsk } from "../windows/windowClose";
import { lastFocusedEligibleWindow } from "./automationWindows";
import { now } from "./socketTargets";
import { OpError } from "./workspaceTargets";

export const UNSEEN = "Ardia would have to ask first, and nobody can see that question here (its window isn't on screen, or Ardia runs in the background)";

const waiting = new Set<() => void>();

export function askWhereSeen(outcome: string): CloseAsk {
  return async (options) => {
    let dismiss = () => {};
    const dismissed = new Promise<"dismissed">((resolve) => (dismiss = () => resolve("dismissed")));
    waiting.add(dismiss);
    try {
      const answer = await Promise.race([confirm({ ...options, onlyIfShown: true }), dismissed]);
      if (answer === "dismissed") throw new OpError("refused", `${outcome}: control was turned off before anyone answered, so Ardia took the question away.`);
      if (answer.unshown) throw new OpError("refused", `${outcome}: ${UNSEEN}.`);
      return answer;
    } finally {
      waiting.delete(dismiss);
    }
  };
}

export function dismissSocketAsks() {
  if (!waiting.size) return;
  for (const dismiss of [...waiting]) dismiss();
  void dismissShownOnlyDialogs().catch(() => {});
}

export const shownWindowId = (): string | undefined => lastFocusedEligibleWindow(now()) ?? undefined;
