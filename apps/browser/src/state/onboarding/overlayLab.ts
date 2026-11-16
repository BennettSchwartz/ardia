import { overlayLabValue } from "../../platform/launchConfig";

export const overlayStartsOpaque = () => overlayLabValue("overlayNoFade") === "1";

export function lateOnboardingMs(): number {
  const asked = Number(overlayLabValue("onboardingLateMs"));
  return Number.isFinite(asked) && asked > 0 ? asked : 0;
}

export function noteOverlay(text: string) {
  if (overlayLabValue("overlayMarks") === "1") console.info(`[ardia overlay] ${text}`);
}
