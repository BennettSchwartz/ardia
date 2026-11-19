import { useEffect, useRef } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ViewInstance } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useReduceMotion } from "./contrast";
import { useCoverFocus } from "./coverFocus";
import type { Confirmation } from "./Dialog";
import { countDrawnMenuOpened, MenuMaterial } from "./Menu";
import { menuMotion } from "./motion";
import { Portal, usePortalLeaving } from "./Overlay";
import { actionSheetInk, actionSheetLook, ink } from "./tokens";
import { useTheme } from "./theme";

export type SheetAction = { title: string; destructive?: boolean; onPress: () => void };

type Props = { title?: string | null; message?: string | null; actions: SheetAction[]; cancel?: string; onCancel: () => void };

export function ActionSheet(props: Props) {
  return (
    <Portal exitMs={menuMotion.sheetOut}>
      <SheetCard {...props} />
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
  const leaving = usePortalLeaving();
  const shown = useSharedValue(1);
  useEffect(() => {
    if (leaving) shown.value = withTiming(0, { duration: reduceMotion ? menuMotion.contentFade : menuMotion.sheetOut });
  }, [leaving]);
  const fade = useAnimatedStyle(() => ({ opacity: shown.value }));
  useCoverFocus(card, !leaving);
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
      <Pressable accessibilityRole="button" accessibilityLabel={cancel} style={[StyleSheet.absoluteFill, { backgroundColor: ink.clear }]} onPress={onCancel} />
      <View style={styles.centre} pointerEvents="box-none">
        <View ref={card} testID="drawnActionSheet" accessibilityViewIsModal style={[styles.card, { width, maxHeight, borderColor: paint.rim, boxShadow: actionSheetLook.shadow }]}>
          <MenuMaterial source={null} fill={paint.fill} solid={paint.solid} radius={actionSheetLook.radius} style={[styles.material, { maxHeight: maxHeight - 2 * actionSheetLook.rim }]}>
            <ScrollView testID="drawnConfirmationScroll" keyboardShouldPersistTaps="handled" style={styles.scroll} contentContainerStyle={styles.content} bounces={false} overScrollMode="never">
            {title ? (
              <Text accessibilityRole="header" style={[actionSheetLook.title, { color: paint.title }]}>
                {title}
              </Text>
            ) : null}
            {message ? (
              <Text textBreakStrategy="balanced" style={[actionSheetLook.message, styles.message, { color: paint.message }]}>
                {message}
              </Text>
            ) : null}
            <View style={[styles.buttons, title || message ? styles.afterText : null]}>
              {actions.map((action, index) => (
                <Pressable
                  key={`${index}:${action.title}`}
                  accessibilityRole="button"
                  accessibilityLabel={action.title}
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
