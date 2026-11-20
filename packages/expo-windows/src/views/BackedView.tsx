import { useCallback, useRef, type Ref, type RefCallback } from "react";
import { processColor, StyleSheet, TurboModuleRegistry, type TurboModule, type View, type ViewProps } from "react-native";
import { backedStyles, fillPointerEvents, processedColorDraws, routedNativeStyle, touchesFill, type ColorDraws, type Flat, type PointerEvents } from "./backgroundFill";
import { RawView } from "./raw/rawView";

type NativeProps = { style?: unknown } & Record<string, unknown>;
type Routable = View & { setNativeProps(props: NativeProps): void };
type Routing = { fill: { current: View | null }; latest: Flat | null; paintedRaw: boolean; routed: WeakSet<object> };
type LaunchConfig = TurboModule & { launchConfig(): { test?: Record<string, string> } };

const useMergeRefs: <T>(...refs: (Ref<T> | undefined)[]) => RefCallback<T> = require("react-native/Libraries/Utilities/useMergeRefs").default;

let raw: boolean | null = null;

function drawsBackgroundsRaw(): boolean {
  if (raw !== null) return raw;
  try {
    raw = TurboModuleRegistry.get<LaunchConfig>("ArdiaApp")?.launchConfig().test?.rawBackgrounds === "1";
  } catch {
    raw = false;
  }
  return raw;
}

const draws: ColorDraws = (color) => color != null && color !== "transparent" && processedColorDraws(processColor(color as Parameters<typeof processColor>[0]));

function routeNativeProps(instance: Routable, routing: Routing) {
  if (routing.routed.has(instance)) return;
  routing.routed.add(instance);
  const original = instance.setNativeProps;
  if (typeof original !== "function") return;
  try {
    instance.setNativeProps = (props: NativeProps) => {
      const fill = routing.fill.current as Routable | null;
      const style = props?.style == null ? null : (StyleSheet.flatten(props.style as never) as Flat | undefined);
      if (!style || !touchesFill(style)) return original.call(instance, props);
      if (!fill || !routing.latest) {
        if (draws(style.backgroundColor)) routing.paintedRaw = true;
        return original.call(instance, props);
      }
      const routed = routedNativeStyle(routing.latest, style);
      routing.latest = routed.latest;
      fill.setNativeProps({ style: routed.fill });
      return original.call(instance, { ...props, style: routed.own });
    };
  } catch {
    routing.routed.delete(instance);
  }
}

export function BackedView({ ref, style, children, pointerEvents, ...rest }: ViewProps & { ref?: Ref<View> }) {
  const fill = useRef<View>(null);
  const routing = useRef<Routing>({ fill, latest: null, paintedRaw: false, routed: new WeakSet() }).current;
  const route = useCallback((instance: View | null) => void (instance && routeNativeProps(instance as Routable, routing)), [routing]);
  const merged = useMergeRefs(route, ref);
  const flat = style == null || drawsBackgroundsRaw() || routing.paintedRaw ? null : (StyleSheet.flatten(style) as Flat | undefined);
  const backed = flat ? backedStyles(flat, draws) : null;
  if (!backed && flat && draws(flat.backgroundColor)) routing.paintedRaw = true;
  routing.latest = backed ? flat! : null;
  const passThrough = fillPointerEvents((pointerEvents ?? flat?.pointerEvents) as PointerEvents);
  return (
    <RawView {...rest} pointerEvents={pointerEvents} ref={merged} style={backed ? backed.own : style}>
      {backed ? <RawView ref={fill} pointerEvents={passThrough} style={backed.fill} /> : null}
      {children}
    </RawView>
  );
}

BackedView.displayName = "View";

export default BackedView;
