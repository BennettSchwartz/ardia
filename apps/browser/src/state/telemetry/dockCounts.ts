import type { WindowEvent } from "../../platform/windows";
import { isSharing, onConsentPeriodChange } from "./choice";

type ScreenEdge = NonNullable<Extract<WindowEvent, { type: "sidebarEdge" }>["screenEdge"]>;

const NONE = {
  sidebar_slides: 0,
  sidebar_slides_past_target: 0,
  sidebar_page_full_screen_peeks: 0,
  sidebar_peek_reveals_held_back: 0,
  sidebar_peek_resizes: 0,
  sidebar_peek_closes_while_resizing: 0,
  sidebar_screen_edge_stops: 0,
  sidebar_screen_edge_pass_throughs: 0,
  sidebar_screen_edge_flings: 0,
  sidebar_full_screen_peeks: 0,
  sidebar_full_screen_peek_quick_closes: 0,
  sidebar_field_remeasures: 0,
};

export const QUICK_PEEK_CLOSE_MS = 500;
let counts = { ...NONE };

export function noteSidebarSlide(pastTarget: boolean) {
  if (!isSharing()) return;
  counts.sidebar_slides++;
  if (pastTarget) counts.sidebar_slides_past_target++;
}

export const noteSidebarPeekRevealHeldBack = () => void (isSharing() && counts.sidebar_peek_reveals_held_back++);

export const notePageFullScreenPeek = () => void (isSharing() && counts.sidebar_page_full_screen_peeks++);

export const noteSidebarPeekResize = () => void (isSharing() && counts.sidebar_peek_resizes++);

export const noteSidebarPeekClosedWhileResizing = () => void (isSharing() && counts.sidebar_peek_closes_while_resizing++);

const SCREEN_EDGE_COUNTS = {
  stopped: "sidebar_screen_edge_stops",
  passed: "sidebar_screen_edge_pass_throughs",
  flung: "sidebar_screen_edge_flings",
} as const satisfies Record<ScreenEdge, keyof typeof NONE>;

export const noteSidebarScreenEdge = (edge: ScreenEdge) => void (isSharing() && counts[SCREEN_EDGE_COUNTS[edge]]++);

export const noteFullScreenPeek = () => void (isSharing() && counts.sidebar_full_screen_peeks++);

export const noteFullScreenPeekClosed = (shownMs: number) => void (isSharing() && shownMs < QUICK_PEEK_CLOSE_MS && counts.sidebar_full_screen_peek_quick_closes++);

export const noteSidebarFieldRemeasure = () => void (isSharing() && counts.sidebar_field_remeasures++);

export function takeDockCounts() {
  const taken = counts;
  counts = { ...NONE };
  return taken;
}

onConsentPeriodChange(() => void takeDockCounts());
