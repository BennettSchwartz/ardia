import { onPressLoopLong, type PressLoopLongReport } from "../../platform/performance";
import { capture, stillValid, type ConsentToken } from "./client";

const LOOPS = new Set(["windowDragRegion", "windowMove"]);
const MAX_EVENTS = 10;

let sent = 0;
let watching = false;

const loopName = (value: unknown) => (typeof value === "string" && LOOPS.has(value) ? value : "other");

export function pressLoopLongProperties(r: PressLoopLongReport) {
  return { loop: loopName(r.loop), inner: loopName(r.inner), still_open: r.open === true, buttons_held: r.buttonsHeld === true };
}

export function trackPressLoopLong(r: PressLoopLongReport) {
  const consent = (r.epoch ?? null) as ConsentToken | null;
  if (sent >= MAX_EVENTS) return;
  if (stillValid(consent)) sent++;
  capture("press_loop_long", pressLoopLongProperties(r), consent);
}

export function watchPressLoops() {
  if (watching) return;
  watching = true;
  onPressLoopLong(trackPressLoopLong);
}
