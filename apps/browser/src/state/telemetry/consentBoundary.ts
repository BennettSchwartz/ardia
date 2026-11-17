import { setConsentEpoch } from "../../platform/focus";
import { consentEpoch, useTelemetry } from "./choice";
import { takeContentDriftCounts, takeMainProcessWork } from "./diagnostics";
import { resetLocalStoreMeters } from "./localStore";

let dropUsage = () => {};

useTelemetry.subscribe((current, previous) => {
  if (current.sharing === previous.sharing && current.epoch === previous.epoch) return;
  setConsentEpoch(consentEpoch());
  dropUsage();
  resetLocalStoreMeters();
  void takeMainProcessWork().catch(() => null);
  void takeContentDriftCounts().catch(() => null);
});

export function watchConsentBoundary(drop: () => void) {
  dropUsage = drop;
  setConsentEpoch(consentEpoch());
}
