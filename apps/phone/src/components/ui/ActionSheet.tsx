import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, findNodeHandle, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useReduceMotion } from "./contrast";
import { focusForScreenReader, takeHandedFocus } from "./coverFocus";
import { screenReaderActions } from "./screenReaderActions";
import type { Confirmation } from "./Dialog";
import { countDrawnMenuOpened, MenuMaterial } from "./Menu";
import { menuMotion } from "./motion";
import { Portal, useOverlayAfterClear, useOverlayCovered, useOverlayGeneration, usePortalLeaving, usePortalLeft } from "./Overlay";
import { actionSheetInk, actionSheetLook, ink } from "./tokens";
import { useTheme } from "./theme";

export type SheetAction = { title: string; destructive?: boolean; onPress: () => void };

type Props = { title?: string | null; message?: string | null; actions: SheetAction[]; cancel?: string; onCancel: () => void; opener?: unknown };

export function ActionSheet({ onCancel, opener, ...props }: Props) {
  const [returnTo] = useState(() => {
    const handed = takeHandedFocus();
    return { target: opener ? () => opener as Parameters<typeof findNodeHandle>[0] : handed };
  });
  const afterClear = useOverlayAfterClear();
  const generation = useOverlayGeneration();
  const covered = useOverlayCovered();
  const cancelled = useCallback(() => {
    onCancel();
    const target = returnTo.target;
    if (!target) return;
    const openedBefore = generation();
    afterClear(() => focusForScreenReader(target, () => generation() === openedBefore && !covered(), { refocus: true }));
  }, [onCancel, returnTo, afterClear, generation, covered]);
  return (
    <Portal exitMs={menuMotion.sheetOut}>
      <SheetCard {...props} onCancel={cancelled} />
    </Portal>
  );
}

function SheetCard({ title, message, actions, cancel = "Cancel", onCancel }: Props) {
  const theme = useTheme();
  const paint = theme.dark ? actionSheetInk.dark : actionSheetInk.light;
  const reduceMotion = useReduceMotion();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = confirmCardWidth(window.fontScale, window.width - insets.left - insets.right);
  const maxHeight = window.height - insets.top - insets.bottom - 2 * actionSheetLook.screenMargin;
  const card = useRef<ViewInstance>(null);
  const spoken = useRef<ViewInstance>(null);
  const firstAction = useRef<ViewInstance>(null);
  const announces = Platform.OS === "android";
  const heading = title && message ? `${title}${/[.?!]$/.test(title) ? "" : "."} ${message}` : title || message || "";
  const leaving = usePortalLeaving();
  const left = usePortalLeft();
  const shown = useSharedValue(1);
  useEffect(() => {
    if (leaving) shown.value = withTiming(0, { duration: reduceMotion ? menuMotion.contentFade : menuMotion.sheetOut }, (finished) => finished && runOnJS(left)());
  }, [leaving]);
  const fade = useAnimatedStyle(() => ({ opacity: shown.value }));
  useEffect(() => {
    if (leaving) return;
    return focusForScreenReader(() => (heading ? spoken : firstAction).current);
  }, [leaving]);
  const cancelAction = announces ? screenReaderActions([{ name: "cancel", label: cancel, run: onCancel }]) : {};
  useEffect(() => {
    countDrawnMenuOpened();
  }, []);
  useEffect(() => {
    if (leaving) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      onCancel();
      return true;
    });
    return () => back.remove();
  }, [onCancel, leaving]);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, fade]} pointerEvents={leaving ? "none" : "auto"} collapsable={false} accessibilityElementsHidden={leaving} importantForAccessibility={leaving ? "no-hide-descendants" : "auto"}>
      <Pressable testID="drawnConfirmationOutside" {...(announces ? { accessible: false, importantForAccessibility: "no" as const } : { accessibilityRole: "button" as const, accessibilityLabel: cancel })} style={[StyleSheet.absoluteFill, { backgroundColor: ink.clear }]} onPress={onCancel} />
      <View style={styles.centre} pointerEvents="box-none">
        <View ref={card} testID="drawnActionSheet" accessibilityViewIsModal style={[styles.card, { width, maxHeight, borderColor: paint.rim, boxShadow: actionSheetLook.shadow }]}>
          <MenuMaterial source={null} fill={paint.fill} solid={paint.solid} radius={actionSheetLook.radius} style={[styles.material, { maxHeight: maxHeight - 2 * actionSheetLook.rim }]}>
            <ScrollView testID="drawnConfirmationScroll" keyboardShouldPersistTaps="handled" style={styles.scroll} contentContainerStyle={styles.content} bounces={false} overScrollMode="never">
            {heading ? (
              <View ref={spoken} testID="drawnConfirmationHeading" accessible accessibilityRole="header" accessibilityLabel={heading} {...cancelAction}>
                {title ? <Text style={[actionSheetLook.title, { color: paint.title }]}>{title}</Text> : null}
                {message ? (
                  <Text textBreakStrategy="balanced" style={[actionSheetLook.message, styles.message, { color: paint.message }]}>
                    {message}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <View style={[styles.buttons, title || message ? styles.afterText : null]}>
              {actions.map((action, index) => (
                <Pressable
                  ref={index === 0 ? firstAction : undefined}
                  key={`${index}:${action.title}`}
                  accessibilityRole="button"
                  accessibilityLabel={action.title}
                  {...(announces ? screenReaderActions([{ name: "activate", run: action.onPress }, { name: "cancel", label: cancel, run: onCancel }]) : {})}
                  onPress={action.onPress}
                  style={({ pressed }) => [styles.button, { backgroundColor: paint.button }, pressed ? styles.pressed : null]}
                >
                  <Text style={[actionSheetLook.button, styles.centred, { color: action.destructive ? paint.destructive : paint.title }]}>
                    {action.title}
                  </Text>
                </Pressable>
              ))}
            </View>
            </ScrollView>
          </MenuMaterial>
        </View>
      </View>
    </Animated.View>
  );
}

export const confirmCardWidth = (fontScale: number, room: number) => Math.min(actionSheetLook.width * Math.max(1, fontScale), room - 2 * actionSheetLook.screenMargin);

export function ConfirmSheet({ confirmation, onClose }: { confirmation: Confirmation; onClose: () => void }) {
  return (
    <ActionSheet
      title={confirmation.title}
      message={confirmation.message}
      onCancel={onClose}
      opener={confirmation.opener}
      actions={[
        {
          title: confirmation.action,
          destructive: confirmation.destructive !== false,
          onPress: () => {
            onClose();
            confirmation.run();
          },
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  centre: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  card: { borderRadius: actionSheetLook.radius, borderWidth: actionSheetLook.rim },
  material: { overflow: "hidden" },
  scroll: { flexGrow: 0 },
  content: { paddingTop: actionSheetLook.top, paddingHorizontal: actionSheetLook.side, paddingBottom: actionSheetLook.buttonBottom },
  message: { marginTop: actionSheetLook.messageGap },
  buttons: { marginHorizontal: actionSheetLook.buttonSide - actionSheetLook.side, gap: actionSheetLook.buttonsBetween },
  afterText: { marginTop: actionSheetLook.buttonGap },
  button: { minHeight: actionSheetLook.buttonHeight, borderRadius: actionSheetLook.buttonHeight / 2, justifyContent: "center", paddingHorizontal: actionSheetLook.buttonSide, paddingVertical: (actionSheetLook.buttonHeight - actionSheetLook.button.lineHeight) / 2 },
  pressed: { opacity: 0.7 },
  centred: { textAlign: "center" },
});
