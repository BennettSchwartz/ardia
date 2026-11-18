import { useEffect, useRef, useState, type ReactNode } from "react";
import { BackHandler, KeyboardAvoidingView, Pressable, StyleSheet, Text, useWindowDimensions, View, type ViewInstance, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { interpolateColor, runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { predictiveBack, TRAY_BACK_TRAVEL } from "@ardia/phone-native";
import { withAlpha } from "../../lib/color";
import { clampedProgress, trayDragDismisses, trayDragOffset } from "../../lib/trayMotion";
import { useReduceMotion } from "./contrast";
import { useCoverFocus } from "./coverFocus";
import { MATERIAL_STATE } from "./materialRoles";
import { useMaterialTheme } from "./materialTheme";
import { materialDuration, materialMotion, materialMove, materialShape, materialSize, materialType } from "./materialTokens";
import { reducedMotionMs } from "./motion";
import { Portal } from "./Overlay";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";

const HIDE_FALLBACK_MS = 900;
const SHEET_TOP_GAP = materialSize.topAppBar;

type MaterialBackHandlers = { onProgress?: (progress: number) => void; onCancel?: () => void; onCommit: () => void };

export function useMaterialBack(active: boolean, handlers: MaterialBackHandlers, fallback = true) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!active) return;
    if (predictiveBack.isNative()) {
      const claim = predictiveBack.claim({ onProgress: (progress) => latest.current.onProgress?.(progress), onCancel: () => latest.current.onCancel?.(), onCommit: () => latest.current.onCommit() });
      return () => claim.remove();
    }
    if (!fallback) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      latest.current.onCommit();
      return true;
    });
    return () => back.remove();
  }, [active, fallback]);
}

export const materialSheetBackOffset = (progress: number) => Math.min(Math.max(progress, 0), 1) * TRAY_BACK_TRAVEL;

export function useMaterialRipple(borderless = false) {
  const { scheme } = useMaterialTheme();
  return { color: withAlpha(scheme.onSurface, MATERIAL_STATE.pressed), borderless, foreground: !borderless };
}

export function DragHandle({ onPress }: { onPress?: () => void }) {
  const { scheme } = useMaterialTheme();
  return (
    <Pressable testID="materialDragHandle" accessibilityRole="button" accessibilityLabel="Dismiss" onPress={onPress} disabled={!onPress} style={styles.handleHit}>
      <View style={[styles.handle, { backgroundColor: withAlpha(scheme.onSurfaceVariant, 0.4) }]} />
    </Pressable>
  );
}

export const MATERIAL_SWITCH = { width: 52, height: 32, border: 2, handleOff: 16, handleOn: 24 } as const;

export const materialSwitchHandle = (on: number) => {
  "worklet";
  const inner = MATERIAL_SWITCH.height - MATERIAL_SWITCH.border * 2;
  const size = MATERIAL_SWITCH.handleOff + (MATERIAL_SWITCH.handleOn - MATERIAL_SWITCH.handleOff) * on;
  const offLeft = (inner - MATERIAL_SWITCH.handleOff) / 2;
  const onLeft = MATERIAL_SWITCH.width - MATERIAL_SWITCH.border * 2 - MATERIAL_SWITCH.handleOn - (inner - MATERIAL_SWITCH.handleOn) / 2;
  return { size, left: offLeft + (onLeft - offLeft) * on, top: (inner - size) / 2 };
};

export function MaterialSwitchTrack({ value, disabled }: { value: boolean; disabled?: boolean }) {
  const { scheme } = useMaterialTheme();
  const reduceMotion = useReduceMotion();
  const on = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    on.value = materialMove(value ? 1 : 0, "standard", reduceMotion ? reducedMotionMs(materialDuration.short4) : materialDuration.short4);
  }, [value]);
  const trackOff = scheme.surfaceContainerHighest;
  const trackOn = scheme.primary;
  const borderOff = scheme.outline;
  const handleOff = scheme.outline;
  const handleOn = scheme.onPrimary;
  const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(on.value, [0, 1], [trackOff, trackOn]), borderColor: interpolateColor(on.value, [0, 1], [borderOff, trackOn]) }), [trackOff, trackOn, borderOff]);
  const handle = useAnimatedStyle(() => {
    const place = materialSwitchHandle(on.value);
    return { width: place.size, height: place.size, borderRadius: place.size / 2, left: place.left, top: place.top, backgroundColor: interpolateColor(on.value, [0, 1], [handleOff, handleOn]) };
  }, [handleOff, handleOn]);
  return (
    <Animated.View testID="materialSwitch" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.switchTrack, track, disabled ? styles.switchDisabled : null]}>
      <Animated.View style={[styles.switchHandle, handle]} />
    </Animated.View>
  );
}

export const materialSheetMs = (reduceMotion: boolean, entering: boolean) =>
  reduceMotion ? reducedMotionMs(materialDuration.short3) : entering ? materialMotion.sheetEnter.durationMs : materialMotion.sheetExit.durationMs;

type SheetProps = { open: boolean; onDismiss: () => void; onHidden: () => void; children: ReactNode };

export function MaterialSheet({ open, onDismiss, onHidden, children }: SheetProps) {
  const { scheme } = useMaterialTheme();
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const across = Math.max(width - insets.left - insets.right, 0);
  const sheetWidth = Math.min(across, materialSize.sheetMaxWidth);
  const reduceMotion = useReduceMotion();
  const shown = useSharedValue(0);
  const drag = useSharedValue(0);
  const sheetHeight = useSharedValue(height);
  const panel = useRef<ViewInstance>(null);
  useCoverFocus(panel);
  useMaterialBack(
    open,
    {
      onProgress: (progress) => {
        drag.value = materialSheetBackOffset(progress);
      },
      onCancel: () => {
        drag.value = materialMove(0, "standard", materialDuration.short4);
      },
      onCommit: onDismiss,
    },
    false,
  );
  useEffect(() => {
    if (open) {
      drag.value = 0;
      shown.value = materialMove(1, materialMotion.sheetEnter.easing, materialSheetMs(reduceMotion, true));
      return;
    }
    const hidden = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(onHidden)();
    };
    shown.value = materialMove(0, materialMotion.sheetExit.easing, materialSheetMs(reduceMotion, false), hidden);
    const fallback = setTimeout(onHidden, HIDE_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [open]);
  const pull = Gesture.Pan()
    .withTestId("sheetDrag")
    .enabled(open)
    .activeOffsetY([-12, 12])
    .failOffsetX([-24, 24])
    .onUpdate((event) => {
      drag.value = trayDragOffset(event.translationY);
    })
    .onEnd((event) => {
      if (trayDragDismisses(event.translationY, event.velocityY, sheetHeight.value)) {
        runOnJS(onDismiss)();
        return;
      }
      drag.value = materialMove(0, "standard", materialDuration.short4);
    });
  const scrim = useAnimatedStyle(() => ({ opacity: Math.min(Math.max(shown.value, 0), 1) * (1 - clampedProgress(drag.value, sheetHeight.value)) }));
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: reduceMotion ? drag.value : (1 - shown.value) * sheetHeight.value + drag.value }], opacity: reduceMotion ? shown.value : 1 }));
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? "box-none" : "none"} collapsable={false} importantForAccessibility={open ? "auto" : "no-hide-descendants"} accessibilityElementsHidden={!open}>
      <Animated.View testID="materialScrim" style={[StyleSheet.absoluteFill, scrim]}>
        <Pressable accessibilityLabel="Close" style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(scheme.scrim, MATERIAL_STATE.scrim) }]} onPress={onDismiss} />
      </Animated.View>
      <GestureDetector gesture={pull}>
        <Animated.View
          ref={panel}
          testID="materialSheet"
          accessibilityViewIsModal
          onLayout={(event) => {
            sheetHeight.value = event.nativeEvent.layout.height;
          }}
          style={[styles.sheet, { left: insets.left + (across - sheetWidth) / 2, width: sheetWidth, maxHeight: Math.max(height - insets.top - SHEET_TOP_GAP, 0), paddingBottom: insets.bottom, backgroundColor: scheme.surfaceContainerLow }, slide]}
        >
          <DragHandle onPress={onDismiss} />
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

export type MaterialDialogButton = { title: string; onPress: () => void; destructive?: boolean };

export function MaterialDialog({ title, message, buttons, onDismiss, children }: { title: string; message?: string | null; buttons: MaterialDialogButton[]; onDismiss: () => void; children?: ReactNode }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const shown = useSharedValue(0);
  const reduceMotion = useReduceMotion();
  useMaterialBack(true, { onCommit: onDismiss });
  useEffect(() => {
    shown.value = materialMove(1, materialMotion.dialogEnter.easing, reduceMotion ? reducedMotionMs(materialDuration.short3) : materialMotion.dialogEnter.durationMs);
  }, []);
  const scrim = useAnimatedStyle(() => ({ opacity: shown.value }));
  const panel = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ scale: 0.9 + 0.1 * shown.value }] }));
  return (
    <Portal>
      <Animated.View testID="materialDialogScrim" style={[StyleSheet.absoluteFill, scrim]}>
        <Pressable accessibilityLabel="Dismiss" style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(scheme.scrim, MATERIAL_STATE.scrim) }]} onPress={onDismiss} />
      </Animated.View>
      <KeyboardAvoidingView style={styles.center} pointerEvents="box-none">
        <Animated.View testID="materialDialog" accessibilityViewIsModal style={[styles.dialog, { backgroundColor: scheme.surfaceContainerHigh }, panel]}>
          <Text accessibilityRole="header" style={[materialType.headlineSmall, { color: scheme.onSurface }]}>
            {title}
          </Text>
          {message ? <Text style={[materialType.bodyMedium, { color: scheme.onSurfaceVariant }]}>{message}</Text> : null}
          {children}
          <View style={styles.dialogButtons}>
            {buttons.map((button) => (
              <Pressable key={button.title} accessibilityRole="button" android_ripple={ripple} onPress={button.onPress} style={styles.textButton}>
                <Text style={[materialType.labelLarge, { color: button.destructive ? scheme.error : scheme.primary }]}>{button.title}</Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Portal>
  );
}

export type MaterialMenuEntry =
  | { label: string; icon?: SymbolName; destructive?: boolean; checked?: boolean; disabled?: boolean; onPress: () => void; submenu?: false }
  | { label: string; icon?: SymbolName; disabled?: boolean; onPress: () => void; submenu: true }
  | "divider"
  | { heading: string };

export function MaterialMenuPanel({ entries, place, panel }: { entries: MaterialMenuEntry[]; place: ViewStyle; panel?: React.RefObject<ViewInstance | null> }) {
  const { scheme } = useMaterialTheme();
  const ripple = useMaterialRipple();
  const shown = useSharedValue(0);
  useEffect(() => {
    shown.value = materialMove(1, materialMotion.menuEnter.easing, materialMotion.menuEnter.durationMs);
  }, []);
  const enter = useAnimatedStyle(() => ({ opacity: Math.min(1, shown.value * 3), transform: [{ scaleY: 0.8 + 0.2 * shown.value }] }));
  return (
    <Animated.View ref={panel} testID="materialMenu" accessibilityViewIsModal style={[styles.menu, place, { backgroundColor: scheme.surfaceContainer }, enter]}>
      {entries.map((entry, index) => {
        if (entry === "divider") return <View key={`d${index}`} style={[styles.menuDivider, { backgroundColor: scheme.outlineVariant }]} />;
        if ("heading" in entry)
          return (
            <Text key={`h${index}`} style={[materialType.titleSmall, styles.menuHeading, { color: scheme.onSurfaceVariant }]}>
              {entry.heading}
            </Text>
          );
        const destructive = !entry.submenu && entry.destructive;
        const color = entry.disabled ? withAlpha(scheme.onSurface, MATERIAL_STATE.disabledContent) : destructive ? scheme.error : scheme.onSurface;
        const iconColor = entry.disabled ? color : destructive ? scheme.error : scheme.onSurfaceVariant;
        return (
          <Pressable
            key={`${index}:${entry.label}`}
            accessibilityRole="menuitem"
            accessibilityLabel={entry.label}
            accessibilityState={entry.submenu ? { disabled: entry.disabled, expanded: false } : { checked: entry.checked, disabled: entry.disabled }}
            disabled={entry.disabled}
            android_ripple={ripple}
            onPress={entry.onPress}
            style={styles.menuItem}
          >
            {entry.icon ? <Symbol name={entry.icon} size={materialSize.icon} color={iconColor} /> : null}
            <Text style={[materialType.labelLarge, styles.menuLabel, { color }]} numberOfLines={1}>
              {entry.label}
            </Text>
            {entry.submenu ? <Symbol name="chevronRight" size={materialSize.icon} color={iconColor} /> : entry.checked ? <Symbol name="checkmark" size={materialSize.icon} color={scheme.primary} /> : null}
          </Pressable>
        );
      })}
    </Animated.View>
  );
}

export function useMaterialMenuPage<T>() {
  return useState<T | null>(null);
}

const styles = StyleSheet.create({
  switchTrack: { width: MATERIAL_SWITCH.width, height: MATERIAL_SWITCH.height, borderRadius: MATERIAL_SWITCH.height / 2, borderWidth: MATERIAL_SWITCH.border },
  switchHandle: { position: "absolute" },
  switchDisabled: { opacity: MATERIAL_STATE.disabledContent },
  handleHit: { alignSelf: "center", width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center" },
  handle: { width: materialSize.dragHandle.width, height: materialSize.dragHandle.height, borderRadius: materialShape.full },
  sheet: {
    position: "absolute",
    bottom: 0,
    overflow: "hidden",
    borderTopLeftRadius: materialShape.extraLarge,
    borderTopRightRadius: materialShape.extraLarge,
    elevation: 1,
  },
  center: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", padding: 24 },
  dialog: { minWidth: 280, maxWidth: 560, width: "100%", borderRadius: materialShape.extraLarge, padding: 24, gap: 16, elevation: 3 },
  dialogButtons: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 },
  textButton: { minHeight: materialSize.touchTarget, minWidth: materialSize.touchTarget, paddingHorizontal: 12, justifyContent: "center", alignItems: "center", borderRadius: materialShape.full, overflow: "hidden" },
  menu: { position: "absolute", minWidth: 112, maxWidth: 280, borderRadius: materialShape.extraSmall, paddingVertical: 8, elevation: 3, overflow: "hidden", transformOrigin: "top" },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: materialSize.touchTarget, paddingHorizontal: 12 },
  menuLabel: { flex: 1 },
  menuHeading: { paddingHorizontal: 12, paddingVertical: 8 },
  menuDivider: { height: 1, marginVertical: 8 },
});
