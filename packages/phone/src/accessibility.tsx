import { createElement, type ComponentType, type ReactNode } from "react";
import { requireNativeViewManager, requireOptionalNativeModule } from "expo-modules-core";
import { View, type NativeSyntheticEvent, type ViewProps } from "react-native";

export type ScrollActionDirection = "forward" | "backward";

export type ScrollActionsProps = ViewProps & {
  canScrollForward: boolean;
  canScrollBackward: boolean;
  onScrollAction: (direction: ScrollActionDirection) => void;
  children?: ReactNode;
};

type NativeProps = Omit<ScrollActionsProps, "onScrollAction"> & {
  onScrollAction: (event: NativeSyntheticEvent<{ direction: ScrollActionDirection }>) => void;
};

type NativeAccessibility = { focusView?: (tag: number) => Promise<void>; announce?: (text: string) => Promise<void> };

const native = requireOptionalNativeModule<NativeAccessibility>("ArdiaPhoneAccessibility");

const hasNative = native !== null;

export const screenReaderFocusIsNative = () => typeof native?.focusView === "function";

export function focusViewNatively(tag: number) {
  void native?.focusView?.(tag).catch(() => undefined);
}

export function announceNatively(text: string) {
  void native?.announce?.(text).catch(() => undefined);
}

let nativeView: ComponentType<NativeProps> | undefined;
const view = () => (nativeView ??= requireNativeViewManager<NativeProps>("ArdiaPhoneAccessibility", "ScrollActions"));

export function ScrollActions({ onScrollAction, canScrollForward, canScrollBackward, ...rest }: ScrollActionsProps) {
  if (!hasNative) return createElement(View, rest);
  return createElement(view(), { ...rest, canScrollForward, canScrollBackward, onScrollAction: (event) => onScrollAction(event.nativeEvent.direction) });
}
