import { save, savedChoice, sessionId } from "./choice";
import { captureHeld, endSession, releaseHeld } from "./client";

let lastQuitBeforeThisOne: number | null | undefined;

export function endSessionForQuit(props: Record<string, unknown>) {
  lastQuitBeforeThisOne = savedChoice().lastQuitAt;
  captureHeld("app_session_ended", props);
  endSession();
}

export function reopenSessionAfterCancelledQuit() {
  if (lastQuitBeforeThisOne === undefined) return false;
  const lastQuitAt = lastQuitBeforeThisOne;
  lastQuitBeforeThisOne = undefined;
  releaseHeld(true);
  save({ sessionOpen: true, sessionId: sessionId(), lastQuitAt });
  return true;
}
