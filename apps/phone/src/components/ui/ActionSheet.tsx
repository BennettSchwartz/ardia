import { useEffect, useRef } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { useReduceMotion } from "./contrast";
import { useCoverFocus } from "./coverFocus";
import type { Confirmation } from "./Dialog";
import { countDrawnMenuOpened, MenuMaterial, useMenuFrost } from "./Menu";
import { menuMotion } from "./motion";
import { Portal } from "./Overlay";
import { actionSheetInk, actionSheetLook, ink } from "./tokens";
import { useTheme } from "./theme";

export type SheetAction = { title: string; destructive?: boolean; onPress: () => void };

type Props = { title?: string | null; message?: string | null; actions: SheetAction[]; cancel?: string; onCancel: () => void };

export function ActionSheet(props: Props) {
  const frost = useMenuFrost();
  return (
    <Portal>
      <SheetCard {...props} frost={frost} />
    </Portal>
  );
}

function SheetCard({ title, message, actions, cancel = "Cancel", onCancel, frost }: Props & { frost: string | null }) {
  const theme = useTheme();
  const paint = theme.dark ? actionSheetInk.dark : actionSheetInk.light;
  const reduceMotion = useReduceMotion();
  const card = useRef<ViewInstance>(null);
  useCoverFocus(card);
  useEffect(() => {
    countDrawnMenuOpened();
  }, []);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      onCancel();
      return true;
    });
    return () => back.remove();
  }, [onCancel]);
  return (
    <Animated.View style={StyleSheet.absoluteFill} exiting={reduceMotion ? undefined : FadeOut.duration(menuMotion.sheetOut)}>
      <Pressable accessibilityRole="button" accessibilityLabel={cancel} style={[StyleSheet.absoluteFill, { backgroundColor: ink.clear }]} onPress={onCancel} />
      <View style={styles.centre} pointerEvents="box-none">
        <View ref={card} testID="drawnActionSheet" accessibilityViewIsModal style={[styles.card, { borderColor: paint.rim, boxShadow: actionSheetLook.shadow }]}>
          <MenuMaterial source={frost} fill={paint.fill} solid={paint.solid} radius={actionSheetLook.radius} style={styles.material}>
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
                  <Text numberOfLines={1} style={[actionSheetLook.button, styles.centred, { color: action.destructive ? paint.destructive : paint.title }]}>
                    {action.title}
                  </Text>
                </Pressable>
              ))}
            </View>
          </MenuMaterial>
        </View>
      </View>
    </Animated.View>
  );
}

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
  card: { width: actionSheetLook.width, borderRadius: actionSheetLook.radius, borderWidth: actionSheetLook.rim },
  material: { overflow: "hidden", paddingTop: actionSheetLook.top, paddingHorizontal: actionSheetLook.side, paddingBottom: actionSheetLook.buttonBottom },
  message: { marginTop: actionSheetLook.messageGap },
  buttons: { marginHorizontal: actionSheetLook.buttonSide - actionSheetLook.side, gap: actionSheetLook.buttonsBetween },
  afterText: { marginTop: actionSheetLook.buttonGap },
  button: { height: actionSheetLook.buttonHeight, borderRadius: actionSheetLook.buttonHeight / 2, justifyContent: "center", paddingHorizontal: actionSheetLook.buttonSide },
  pressed: { opacity: 0.7 },
  centred: { textAlign: "center" },
});
