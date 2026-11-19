import type { WindowEvent, WindowGeometry, WindowsNative } from "@ardia/shell";

export const windowGeometries = new Map<string, WindowGeometry>();

type GeometryFakes = Pick<WindowsNative, "windowGeometry" | "setWindowFrame" | "setWindowZoomed" | "setWindowFullScreen">;

export function windowGeometryFakes(isOpen: (id: string) => boolean, emit: (event: WindowEvent) => void): GeometryFakes {
  const of = (id: string): WindowGeometry | null => {
    if (!isOpen(id)) return null;
    if (!windowGeometries.has(id)) windowGeometries.set(id, { frame: [100, 100, 1200, 800], zoomed: false, fullScreen: false, miniaturized: false, visible: true, display: null });
    return windowGeometries.get(id)!;
  };
  return {
    windowGeometry: (id) => Promise.resolve(of(id)),
    setWindowFrame: (id, frame) => {
      const g = of(id);
      if (g && !g.fullScreen) Object.assign(g, { frame: [...frame], zoomed: false });
      return Promise.resolve(g);
    },
    setWindowZoomed: (id, on) => {
      const g = of(id);
      if (g && !g.fullScreen) g.zoomed = on;
      return Promise.resolve(g);
    },
    setWindowFullScreen: (id, on) => {
      const g = of(id);
      if (g && g.fullScreen !== on) {
        g.fullScreen = on;
        queueMicrotask(() => emit({ type: "fullScreen", id, on }));
      }
      return Promise.resolve(g);
    },
  };
}
