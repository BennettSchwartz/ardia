import { Fragment, useEffect, useRef } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View, type ViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReduceMotion } from "./contrast";
import { useCoverFocus } from "./coverFocus";
import type { Confirmation } from "./Dialog";
import { countDrawnMenuOpened, MenuMaterial, useMenuFrost } from "./Menu";
import { menuMotion } from "./motion";
import { Portal } from "./Overlay";
import { useTheme } from "./theme";
import { actionSheetInk, actionSheetLook } from "./tokens";

export type SheetAction = { title: string; destructive?: boolean; onPress: () => void };

type Props = { title?: string | null; message?: string | null; actions: SheetAction[]; cancel?: string; onCancel: () => void };

export function ActionSheet(props: Props) {
  const frost = useMenuFrost();
  return (
    <Portal>
      <SheetPanel {...props} frost={frost} />
    </Portal>
  );
}

function SheetPanel({ title, message, actions, cancel = "Cancel", onCancel, frost }: Props & { frost: string | null }) {
  const theme = useTheme();
  const paint = theme.dark ? actionSheetInk.dark : actionSheetInk.light;
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const panel = useRef<ViewInstance>(null);
  useCoverFocus(panel);
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
  const rise = reduceMotion ? undefined : SlideInDown.springify().mass(menuMotion.sheetIn.mass).stiffness(menuMotion.sheetIn.stiffness).damping(menuMotion.sheetIn.damping);
  const header = Boolean(title || message);
  return (
    <Animated.View style={StyleSheet.absoluteFill} exiting={reduceMotion ? undefined : FadeOut.duration(menuMotion.sheetOut)}>
      <Animated.View entering={reduceMotion ? undefined : FadeIn.duration(menuMotion.dim)} style={StyleSheet.absoluteFill}>
        <Pressable accessibilityLabel="Dismiss" style={[StyleSheet.absoluteFill, { backgroundColor: paint.scrim }]} onPress={onCancel} />
      </Animated.View>
      <View style={[styles.column, { paddingBottom: insets.bottom + actionSheetLook.bottomGap, paddingLeft: insets.left + actionSheetLook.sideInset, paddingRight: insets.right + actionSheetLook.sideInset }]} pointerEvents="box-none">
        <Animated.View ref={panel} testID="drawnActionSheet" accessibilityViewIsModal entering={rise} style={styles.stack}>
          <MenuMaterial source={frost} fill={paint.fill} solid={paint.solid} radius={actionSheetLook.radius} style={styles.group}>
            {header ? (
              <View accessible style={styles.header}>
                {title ? (
                  <Text accessibilityRole="header" style={[actionSheetLook.title, styles.centred, { color: paint.header }]}>
                    {title}
                  </Text>
                ) : null}
                {message ? <Text style={[actionSheetLook.message, styles.centred, { color: paint.header }]}>{message}</Text> : null}
              </View>
            ) : null}
            {actions.map((action, index) => (
              <Fragment key={`${index}:${action.title}`}>
                {header || index > 0 ? <View style={[styles.separator, { backgroundColor: paint.separator }]} /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={action.title}
                  onPress={action.onPress}
                  style={({ pressed }) => [styles.action, pressed ? { backgroundColor: paint.highlight } : null]}
                >
                  <Text numberOfLines={1} style={[actionSheetLook.action, styles.centred, { color: action.destructive ? theme.destructive : theme.formAccent }]}>
                    {action.title}
                  </Text>
                </Pressable>
              </Fragment>
            ))}
          </MenuMaterial>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cancel}
            onPress={onCancel}
            style={({ pressed }) => [styles.group, styles.action, { backgroundColor: paint.cancel }, pressed ? { backgroundColor: paint.highlight } : null]}
          >
            <Text numberOfLines={1} style={[actionSheetLook.action, styles.centred, { color: theme.formAccent, fontWeight: actionSheetLook.cancelWeight }]}>
              {cancel}
            </Text>
          </Pressable>
        </Animated.View>
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
  column: { ...StyleSheet.absoluteFill, justifyContent: "flex-end", alignItems: "center" },
  stack: { width: "100%", maxWidth: actionSheetLook.maxWidth, gap: actionSheetLook.gap },
  group: { borderRadius: actionSheetLook.radius, overflow: "hidden" },
  header: { paddingHorizontal: actionSheetLook.headerSide, paddingVertical: actionSheetLook.headerVertical, gap: actionSheetLook.headerGap },
  centred: { textAlign: "center" },
  separator: { height: StyleSheet.hairlineWidth },
  action: { minHeight: actionSheetLook.rowHeight, justifyContent: "center", paddingHorizontal: actionSheetLook.headerSide },
});
