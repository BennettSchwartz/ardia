import { useEffect, type RefObject } from "react";
import { AccessibilityInfo, findNodeHandle, type View, type ViewInstance } from "react-native";

export function useCoverFocus(target: RefObject<ViewInstance | null>) {
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
      if (!on || !live) return;
      requestAnimationFrame(() => {
        const handle = target.current ? findNodeHandle(target.current) : null;
        if (live && handle) AccessibilityInfo.setAccessibilityFocus(handle);
      });
    });
    return () => {
      live = false;
    };
  }, [target]);
}

type Focusable = Parameters<typeof findNodeHandle>[0];

export function focusForScreenReader(target: () => Focusable | null | undefined, still: () => boolean = () => true) {
  void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
    if (!on) return;
    requestAnimationFrame(() => {
      const view = target();
      const handle = view && still() ? findNodeHandle(view) : null;
      if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
    });
  });
}
