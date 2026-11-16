import { onAppEvent } from "../../platform/app";

let centeredResizes = 0;
let reopenedMaximized = 0;
let dragLoops = 0;

onAppEvent((e) => {
  if (e.type === "centeredResize") centeredResizes++;
  if (e.type === "windowDragLoop") dragLoops++;
});

export const noteWindowReopenedMaximized = () => void reopenedMaximized++;

export function takeWindowPlacementCounts() {
  const taken = { window_centered_resizes: centeredResizes, windows_reopened_maximized: reopenedMaximized, window_drag_loops: dragLoops };
  centeredResizes = 0;
  reopenedMaximized = 0;
  dragLoops = 0;
  return taken;
}
