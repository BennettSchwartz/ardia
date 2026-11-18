import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { StyleSheet, View, type ViewInstance } from "react-native";

export type WindowRect = { x: number; y: number; width: number; height: number };

type Overlay = { show: (id: number, node: ReactNode | null) => void; frame: () => Promise<WindowRect>; layers: () => number };

const OverlayContext = createContext<Overlay | null>(null);

let nextId = 0;

const measure = (view: ViewInstance | null): Promise<WindowRect> =>
  new Promise((resolve) => {
    if (!view) resolve({ x: 0, y: 0, width: 0, height: 0 });
    else view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });

export function OverlayHost({ children }: { children: ReactNode }) {
  const root = useRef<ViewInstance>(null);
  const [layers, setLayers] = useState<{ id: number; node: ReactNode }[]>([]);
  const shownLayers = useRef(0);
  shownLayers.current = layers.length;
  const overlay = useMemo<Overlay>(
    () => ({
      show: (id, node) =>
        setLayers((now) => {
          if (node === null) return now.filter((layer) => layer.id !== id);
          return now.some((layer) => layer.id === id) ? now.map((layer) => (layer.id === id ? { id, node } : layer)) : [...now, { id, node }];
        }),
      frame: () => measure(root.current),
      layers: () => shownLayers.current,
    }),
    [],
  );
  return (
    <OverlayContext.Provider value={overlay}>
      <View style={styles.content} collapsable={false} importantForAccessibility={layers.length ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={layers.length > 0}>
        {children}
      </View>
      <View ref={root} style={StyleSheet.absoluteFill} pointerEvents="box-none" collapsable={false}>
        {layers.map((layer) => (
          <Fragment key={layer.id}>{layer.node}</Fragment>
        ))}
      </View>
    </OverlayContext.Provider>
  );
}

export function Portal({ children }: { children: ReactNode }) {
  const overlay = useContext(OverlayContext);
  const [id] = useState(() => ++nextId);
  useLayoutEffect(() => {
    overlay?.show(id, children);
  });
  useEffect(() => () => overlay?.show(id, null), [overlay, id]);
  return overlay ? null : <>{children}</>;
}

export function useOverlayFrame() {
  const overlay = useContext(OverlayContext);
  return overlay ? overlay.frame : () => Promise.resolve({ x: 0, y: 0, width: 0, height: 0 });
}

export const measureAnchor = (anchor: RefObject<ViewInstance | null>) => measure(anchor.current);

const styles = StyleSheet.create({ content: { flex: 1 } });

export function useOverlayLayers() {
  const overlay = useContext(OverlayContext);
  return overlay ? overlay.layers : () => 0;
}
