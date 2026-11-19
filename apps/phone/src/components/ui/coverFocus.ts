import { useEffect, type RefObject } from "react";
import { AccessibilityInfo, findNodeHandle, Platform, type View, type ViewInstance } from "react-native";

export const ANDROID_FOCUS_DELAY_MS = 250;

type Focusable = Parameters<typeof findNodeHandle>[0];

export function focusForScreenReader(target: () => Focusable | null | undefined, still: () => boolean = () => true) {
  void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
    if (!on || !still()) return;
    const land = () => {
      const view = target();
      const handle = view && still() ? findNodeHandle(view) : null;
      if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
    };
    requestAnimationFrame(() => (Platform.OS === "android" ? setTimeout(land, ANDROID_FOCUS_DELAY_MS) : land()));
  });
}

export function useCoverFocus(target: RefObject<ViewInstance | null>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    focusForScreenReader(
      () => target.current,
      () => live,
    );
    return () => {
      live = false;
    };
  }, [target, enabled]);
}
