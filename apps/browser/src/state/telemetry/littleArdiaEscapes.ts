import { isSharing, onConsentPeriodChange } from "./choice";

export type EscapePressedIn = "page" | "window" | "blankBar";

const none = (): Record<EscapePressedIn, number> => ({ page: 0, window: 0, blankBar: 0 });

let closes = none();
const noHandoffs = () => ({ appLinkCloses: 0, returnsToApp: 0, returnsDropped: 0, globalShortcutOpens: 0, globalShortcutBehind: 0, fitsBelowSaved: 0, keptAtActivation: 0, keptOnArrival: 0, keptOnOpen: 0, heldWithoutLink: 0, holdsLeftToStageManager: 0 });

let handoffs = noHandoffs();

const handoffCounter = { appLinkClose: "appLinkCloses", returnToApp: "returnsToApp", globalShortcut: "globalShortcutOpens", globalShortcutBehind: "globalShortcutBehind" } as const;

export function noteLittleArdiaAppHandoff(what: keyof typeof handoffCounter) {
  if (isSharing()) handoffs[handoffCounter[what]]++;
}

const keptBehindCounter = { activation: "keptAtActivation", arrival: "keptOnArrival", open: "keptOnOpen", released: "heldWithoutLink", stageManager: "holdsLeftToStageManager" } as const;

export function noteLittleArdiaLinkKeptBehind(when: keyof typeof keptBehindCounter) {
  if (isSharing()) handoffs[keptBehindCounter[when]]++;
}

export function noteLittleArdiaReturnsDropped(count: number) {
  if (isSharing()) handoffs.returnsDropped += count;
}

export function noteLittleArdiaFitBelowSaved() {
  if (isSharing()) handoffs.fitsBelowSaved++;
}

export function noteLittleArdiaEscapeClose(pressedIn: EscapePressedIn) {
  if (isSharing()) closes[pressedIn]++;
}

export function takeLittleArdiaEscapeCloses() {
  const taken = closes;
  const handedOff = handoffs;
  closes = none();
  handoffs = noHandoffs();
  return {
    little_ardia_app_link_closes: handedOff.appLinkCloses,
    little_ardia_returns_to_app: handedOff.returnsToApp,
    little_ardia_returns_dropped: handedOff.returnsDropped,
    little_ardia_global_shortcut_opens: handedOff.globalShortcutOpens,
    little_ardia_global_shortcut_behind: handedOff.globalShortcutBehind,
    little_ardia_fits_below_saved_size: handedOff.fitsBelowSaved,
    little_ardia_link_windows_kept_at_activation: handedOff.keptAtActivation,
    little_ardia_link_windows_kept_on_arrival: handedOff.keptOnArrival,
    little_ardia_link_windows_kept_on_open: handedOff.keptOnOpen,
    little_ardia_link_holds_without_link: handedOff.heldWithoutLink,
    little_ardia_link_holds_left_to_stage_manager: handedOff.holdsLeftToStageManager,
    little_ardia_escape_closes: taken.page,
    little_ardia_escape_closes_unfocused: taken.window,
    little_ardia_escape_closes_blank: taken.blankBar,
  };
}

onConsentPeriodChange(() => void takeLittleArdiaEscapeCloses());
