import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { StyleSheet, View, type ViewInstance } from "react-native";

export type WindowRect = { x: number; y: number; width: number; height: number };

type Layer = { id: number; node: ReactNode; leaving: boolean };

type Overlay = { show: (id: number, node: ReactNode | null) => void; leave: (id: number, ms: number) => void; frame: () => Promise<WindowRect>; covered: () => boolean; generation: () => number; onOpened: (listener: () => void) => () => void };

const OverlayContext = createContext<Overlay | null>(null);

const LeavingContext = createContext(false);

export const usePortalLeaving = () => useContext(LeavingContext);

let nextId = 0;

const measure = (view: ViewInstance | null): Promise<WindowRect> =>
  new Promise((resolve) => {
    if (!view) resolve({ x: 0, y: 0, width: 0, height: 0 });
    else view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });

export function OverlayHost({ children }: { children: ReactNode }) {
  const root = useRef<ViewInstance>(null);
  const [layers, setLayers] = useState<Layer[]>([]);
  const coveredNow = useRef(false);
  const shownIds = useRef(new Set<number>());
  const opened = useRef(0);
  const openListeners = useRef(new Set<() => void>());
  coveredNow.current = layers.some((layer) => !layer.leaving);
  const overlay = useMemo<Overlay>(
    () => ({
      show: (id, node) => {
        if (node === null) shownIds.current.delete(id);
        else if (!shownIds.current.has(id)) {
          shownIds.current.add(id);
          opened.current += 1;
          for (const listener of [...openListeners.current]) listener();
        }
        setLayers((now) => {
          if (node === null) return now.filter((layer) => layer.id !== id);
          if (now.some((layer) => layer.id === id)) return now.map((layer) => (layer.id === id ? { id, node, leaving: false } : layer));
          return [...now.filter((layer) => !layer.leaving), { id, node, leaving: false }];
        });
      },
      leave: (id, ms) => {
        setLayers((now) => now.map((layer) => (layer.id === id ? { ...layer, leaving: true } : layer)));
        shownIds.current.delete(id);
        setTimeout(() => setLayers((now) => now.filter((layer) => layer.id !== id || !layer.leaving)), ms);
      },
      frame: () => measure(root.current),
      covered: () => coveredNow.current,
      generation: () => opened.current,
      onOpened: (listener) => {
        openListeners.current.add(listener);
        return () => void openListeners.current.delete(listener);
      },
    }),
    [],
  );
  const covered = layers.some((layer) => !layer.leaving);
  return (
    <OverlayContext.Provider value={overlay}>
      <View testID="overlayCovered" style={styles.content} collapsable={false} importantForAccessibility={covered ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={covered}>
        {children}
      </View>
      <View ref={root} style={StyleSheet.absoluteFill} pointerEvents="box-none" collapsable={false}>
        {layers.map((layer) => (
          <LeavingContext.Provider key={layer.id} value={layer.leaving}>
            {layer.node}
          </LeavingContext.Provider>
        ))}
      </View>
    </OverlayContext.Provider>
  );
}

export function Portal({ exitMs = 0, children }: { exitMs?: number; children: ReactNode }) {
  const overlay = useContext(OverlayContext);
  const [id] = useState(() => ++nextId);
  const leaveAfter = useRef(exitMs);
  leaveAfter.current = exitMs;
  useLayoutEffect(() => {
    overlay?.show(id, children);
  });
  useLayoutEffect(
    () => () => {
      if (leaveAfter.current > 0) overlay?.leave(id, leaveAfter.current);
      else overlay?.show(id, null);
    },
    [overlay, id],
  );
  return overlay ? null : <>{children}</>;
}

export function useOverlayCovered() {
  const overlay = useContext(OverlayContext);
  return overlay ? overlay.covered : () => false;
}

export function useOverlayOpened() {
  const overlay = useContext(OverlayContext);
  return overlay ? overlay.onOpened : () => () => undefined;
}

export function useOverlayGeneration() {
  const overlay = useContext(OverlayContext);
  return overlay ? overlay.generation : () => 0;
}

export function useOverlayFrame() {
  const overlay = useContext(OverlayContext);
  return overlay ? overlay.frame : () => Promise.resolve({ x: 0, y: 0, width: 0, height: 0 });
}

export const measureAnchor = (anchor: RefObject<ViewInstance | null>) => measure(anchor.current);

const styles = StyleSheet.create({ content: { flex: 1 } });
