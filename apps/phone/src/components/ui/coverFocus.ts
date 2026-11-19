import { announceNatively, focusViewNatively, screenReaderFocusIsNative } from "@ardia/phone-native";
import { useEffect, type RefObject } from "react";
import { AccessibilityInfo, findNodeHandle, Platform, type View, type ViewInstance } from "react-native";

export const ANDROID_FOCUS_DELAY_MS = 250;

export const ANDROID_REFOCUS_MS = 300;

type Focusable = Parameters<typeof findNodeHandle>[0];

const nativeFocus = () => Platform.OS === "android" && screenReaderFocusIsNative();

export function focusForScreenReader(target: () => Focusable | null | undefined, still: () => boolean = () => true, { refocus = false }: { refocus?: boolean } = {}): () => void {
  let live = true;
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let again: ReturnType<typeof setTimeout> | null = null;
  let revoke: () => void = () => undefined;
  let revokeAgain: () => void = () => undefined;
  const ok = () => live && still();
  const handleNow = () => {
    const view = target();
    return view ? findNodeHandle(view) : null;
  };
  void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
    if (!on || !ok()) return;
    const land = () => {
      timer = null;
      if (!ok()) return;
      const handle = handleNow();
      if (!handle || !ok()) return;
      if (!nativeFocus()) {
        AccessibilityInfo.setAccessibilityFocus(handle);
        return;
      }
      revoke = focusViewNatively(handle);
      if (!refocus) return;
      again = setTimeout(() => {
        again = null;
        const handleAgain = ok() ? handleNow() : null;
        if (handleAgain && ok()) revokeAgain = focusViewNatively(handleAgain);
      }, ANDROID_REFOCUS_MS);
    };
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!ok()) return;
      if (Platform.OS === "android") timer = setTimeout(land, ANDROID_FOCUS_DELAY_MS);
      else land();
    });
  });
  return () => {
    live = false;
    if (frame !== null) cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
    if (again !== null) clearTimeout(again);
    revoke();
    revokeAgain();
  };
}

type FocusTarget = () => Focusable | null | undefined;

let handedOver: FocusTarget | null = null;

export function handFocusOver(target: FocusTarget) {
  handedOver = target;
  setTimeout(() => {
    if (handedOver === target) handedOver = null;
  }, 0);
}

export function takeHandedFocus(): FocusTarget | null {
  const target = handedOver;
  handedOver = null;
  return target;
}

export function announceForScreenReader(text: string, still: () => boolean = () => true) {
  void AccessibilityInfo.isScreenReaderEnabled().then((on) => {
    if (!on || !still() || !text) return;
    if (nativeFocus()) announceNatively(text);
    else AccessibilityInfo.announceForAccessibility(text);
  });
}

export function useCoverFocus(target: RefObject<ViewInstance | null>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    return focusForScreenReader(() => target.current);
  }, [target, enabled]);
}
