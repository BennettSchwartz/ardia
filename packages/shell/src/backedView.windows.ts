import { requireNativeViewManager } from "expo-modules-core";
import { Animated, type ViewProps } from "react-native";

export const BackedView = requireNativeViewManager<ViewProps>("ArdiaBackedView");

export const AnimatedBackedView = Animated.createAnimatedComponent(BackedView);
