import type { Rect4, WindowEvent, WindowGeometry, WindowsNative } from "@ardia/shell";

export const windowGeometries = new Map<string, WindowGeometry>();

export const geometryWorld = { screens: [[0, 0, 1920, 1080]] as Rect4[], transitionMs: 0 };

type GeometryFakes = Pick<WindowsNative, "windowGeometry" | "setWindowFrame" | "setWindowZoomed" | "setWindowFullScreen">;

const overlaps = (a: Rect4, b: Rect4) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

export function windowGeometryFakes(isOpen: (id: string) => boolean, emit: (event: WindowEvent) => void): GeometryFakes {
  const of = (id: string): WindowGeometry | null => {
    if (!isOpen(id)) return null;
    if (!windowGeometries.has(id)) windowGeometries.set(id, { frame: [100, 100, 1200, 800], zoomed: false, fullScreen: false, miniaturized: false, visible: true, display: null });
    return windowGeometries.get(id)!;
  };
  const copy = (g: WindowGeometry | null) => (g ? { ...g, frame: [...g.frame] as Rect4 } : null);
  return {
    windowGeometry: (id) => Promise.resolve(copy(of(id))),
    setWindowFrame: (id, frame) => {
      const g = of(id);
      if (!g || g.fullScreen) return Promise.resolve(copy(g));
      if (!frame.every(Number.isFinite) || frame[2] <= 0 || frame[3] <= 0) return Promise.resolve({ ...copy(g)!, refused: "invalid" as const });
      if (!geometryWorld.screens.some((screen) => overlaps(screen, frame))) return Promise.resolve({ ...copy(g)!, refused: "offscreen" as const });
      Object.assign(g, { frame: [...frame], zoomed: false });
      return Promise.resolve(copy(g));
    },
    setWindowZoomed: (id, on) => {
      const g = of(id);
      if (g && !g.fullScreen) g.zoomed = on;
      return Promise.resolve(copy(g));
    },
    setWindowFullScreen: (id, on) => {
      const g = of(id);
      if (!g || g.fullScreen === on || g.pageFullScreen) return Promise.resolve(copy(g));
      queueMicrotask(() => emit({ type: "fullScreen", id, on }));
      return new Promise((resolve) =>
        setTimeout(() => {
          g.fullScreen = on;
          resolve(copy(g));
        }, geometryWorld.transitionMs),
      );
    },
  };
}
