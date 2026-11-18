import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle, type ViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring, withTiming, type EntryExitAnimationFunction } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { insetRect, MENU_DIVIDER, MENU_HEADING, MENU_MARGIN, MENU_PADDING, MENU_ROW, menuAt, menuOnTrigger, tallestMenuPage, type Point } from "../../lib/menuPlace";
import { useReduceMotion } from "./contrast";
import { useCoverFocus } from "./coverFocus";
import { LookFrost, SURFACES_FROST } from "./LookViews";
import { menuMotion } from "./motion";
import { measureAnchor, Portal, useOverlayFrame } from "./Overlay";
import { Symbol } from "./Symbol";
import type { SymbolName } from "./symbolPaths";
import { useTheme } from "./theme";
import { font, ink, menuInk, menuLook } from "./tokens";

export type MenuAction = { label: string; icon?: SymbolName; systemImage?: string; destructive?: boolean; checked?: boolean; disabled?: boolean; onPress: () => void };

export type MenuSubmenu = { label: string; icon?: SymbolName; systemImage?: string; disabled?: boolean; children: MenuItem[] };

export type MenuItem = MenuAction | MenuSubmenu | "divider" | { heading: string };

export const isSubmenu = (item: MenuAction | MenuSubmenu): item is MenuSubmenu => "children" in item;

export const submenuPage = (submenu: MenuSubmenu): MenuItem[] => [{ heading: submenu.label }, ...submenu.children];

let drawnMenuOpened: () => void = () => undefined;

export const onDrawnMenuOpened = (handler: () => void) => {
  drawnMenuOpened = handler;
};

export const countDrawnMenuOpened = () => drawnMenuOpened();

const MenuFrostContext = createContext<string | null>(SURFACES_FROST);

export const MenuFrostProvider = MenuFrostContext.Provider;

export const useMenuFrost = () => useContext(MenuFrostContext);

const shrinkAway =
  (ms: number): EntryExitAnimationFunction =>
  () => {
    "worklet";
    return {
      initialValues: { opacity: 1, transform: [{ scale: 1 }] },
      animations: { opacity: withTiming(0, { duration: menuMotion.contentFade }), transform: [{ scale: withTiming(menuMotion.fromScale, { duration: ms }) }] },
    };
  };

const TAP_CLOSE = shrinkAway(menuMotion.close);
const HELD_CLOSE = shrinkAway(menuMotion.heldClose);

const PRESS = menuLook.pressInset;
const CHECK_SHIFT = menuLook.labelInsetChecked - menuLook.labelInset;

type Props = { items: MenuItem[]; place: ViewStyle; onDismiss: () => void; dimmed?: boolean; origin?: string; frost?: string | null; shown?: boolean };

export function Menu({ items, place, onDismiss, dimmed = false, origin = "top", frost, shown = true }: Props) {
  const theme = useTheme();
  const paint = theme.dark ? menuInk.dark : menuInk.light;
  const reduceMotion = useReduceMotion();
  const frostAround = useMenuFrost();
  const source = frost === undefined ? frostAround : frost;
  const [page, setPage] = useState<MenuSubmenu | null>(null);
  const rows = page ? page.children : items;
  const panel = useRef<ViewInstance>(null);
  useCoverFocus(panel);
  useEffect(() => {
    countDrawnMenuOpened();
  }, []);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (page) setPage(null);
      else onDismiss();
      return true;
    });
    return () => back.remove();
  }, [onDismiss, page]);
  const opened = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (shown && !reduceMotion) opened.value = withSpring(1, menuMotion.open);
  }, [shown]);
  const grow = useAnimatedStyle(() => ({ transform: [{ scale: menuMotion.fromScale + (1 - menuMotion.fromScale) * opened.value }] }));
  const checks = rows.some((item) => typeof item === "object" && !("heading" in item) && !isSubmenu(item) && item.checked === true);
  const leading = menuLook.iconSide === "leading";
  const shift = checks ? CHECK_SHIFT : 0;
  const labelLeft = (icon: boolean) => (icon && leading ? menuLook.labelInsetIcon : menuLook.labelInset) + shift - PRESS;
  const iconLeft = menuLook.iconCentre + shift - PRESS - menuLook.iconSlot / 2;
  const pressed = (on: boolean, disabled?: boolean) => [styles.row, on ? { backgroundColor: paint.highlight } : null, disabled ? styles.disabled : null];
  const label = (text: string, color: string, bold = false) => (
    <Text numberOfLines={menuLook.labelLines} style={[menuLook.label, styles.label, bold ? styles.bold : null, { color }]}>
      {text}
    </Text>
  );
  const drawn = rows.map((item, index) => {
    if (item === "divider")
      return (
        <View key={`d${index}`} style={styles.divider}>
          <View style={[styles.dividerLine, { backgroundColor: paint.divider }]} />
        </View>
      );
    if ("heading" in item)
      return (
        <Text key={`h${index}`} accessibilityRole="header" style={[font.footnote, styles.heading, { paddingLeft: menuLook.labelInset + shift, color: paint.heading }]}>
          {item.heading}
        </Text>
      );
    const icon = leading && item.icon ? item.icon : null;
    if (isSubmenu(item))
      return (
        <Pressable
          key={`${index}:${item.label}`}
          accessibilityRole="menuitem"
          accessibilityLabel={item.label}
          accessibilityState={{ disabled: item.disabled, expanded: false }}
          disabled={item.disabled}
          onPress={() => setPage(item)}
          style={({ pressed: on }) => [...pressed(on, item.disabled), { paddingLeft: labelLeft(icon !== null), paddingRight: styles.chevronRoom.paddingRight }]}
        >
          {icon ? <MenuIcon name={icon} color={paint.label} left={iconLeft} /> : null}
          {label(item.label, paint.label)}
          <View style={styles.chevron}>
            <Symbol name="chevronRight" size={menuLook.chevronSize} color={paint.label} />
          </View>
        </Pressable>
      );
    const color = item.destructive ? paint.destructive : paint.label;
    return (
      <Pressable
        key={`${index}:${item.label}`}
        accessibilityRole="menuitem"
        accessibilityLabel={item.label}
        accessibilityState={{ checked: item.checked, disabled: item.disabled }}
        disabled={item.disabled}
        onPress={() => {
          onDismiss();
          item.onPress();
        }}
        style={({ pressed: on }) => [...pressed(on, item.disabled), { paddingLeft: labelLeft(icon !== null) }]}
      >
        {item.checked ? (
          <View style={styles.check}>
            <Symbol name="checkmark" size={menuLook.checkSize} color={color} />
          </View>
        ) : null}
        {icon ? <MenuIcon name={icon} color={color} left={iconLeft} /> : null}
        {label(item.label, color)}
        {!leading && item.icon ? <Symbol name={item.icon} size={menuLook.iconSize} color={color} /> : null}
      </Pressable>
    );
  });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={shown ? "auto" : "none"} collapsable={false} accessibilityElementsHidden={!shown} importantForAccessibility={shown ? "auto" : "no-hide-descendants"}>
      {dimmed ? (
        <Animated.View entering={reduceMotion ? undefined : FadeIn.duration(menuMotion.heldOpen)} exiting={reduceMotion ? undefined : FadeOut.duration(menuMotion.heldClose)} style={[StyleSheet.absoluteFill, { backgroundColor: paint.dim }]} />
      ) : null}
      <Pressable accessibilityLabel="Dismiss" style={[StyleSheet.absoluteFill, { backgroundColor: ink.clear }]} onPress={onDismiss} />
      <Animated.View
        ref={panel}
        testID="drawnMenu"
        accessibilityRole="menu"
        accessibilityViewIsModal
        exiting={reduceMotion ? FadeOut.duration(menuMotion.contentFade) : dimmed ? HELD_CLOSE : TAP_CLOSE}
        style={[styles.panel, { boxShadow: menuLook.shadow, borderColor: paint.rim, transformOrigin: origin }, place, shown ? null : styles.unseen, grow]}
      >
        <MenuMaterial source={source} fill={paint.fill} solid={paint.solid} radius={menuLook.radius} style={styles.material}>
          <View pointerEvents="none" style={[styles.specular, { backgroundColor: paint.specular }]} />
          {page ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Back, ${page.label}`} onPress={() => setPage(null)} style={({ pressed: on }) => [...pressed(on), { paddingLeft: labelLeft(true) }]}>
              <MenuIcon name="chevronLeft" color={paint.label} left={iconLeft} />
              {label(page.label, paint.label, true)}
            </Pressable>
          ) : null}
          {drawn}
        </MenuMaterial>
      </Animated.View>
    </View>
  );
}

export function MenuMaterial({ source, fill, solid, radius, style, children }: { source: string | null; fill: string; solid: string; radius: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  if (!source) return <View style={[style, { backgroundColor: solid, borderRadius: radius }]}>{children}</View>;
  return (
    <LookFrost source={source} variant={menuLook.frost} cornerRadius={radius} fill={fill} style={style}>
      {children}
    </LookFrost>
  );
}

function MenuIcon({ name, color, left }: { name: SymbolName; color: string; left: number }) {
  return (
    <View style={[styles.iconSlot, { left }]}>
      <Symbol name={name} size={menuLook.iconSize} color={color} />
    </View>
  );
}

export function menuAtPoint(at: Point, screen: { width: number; height: number }, insets: { top: number; bottom: number; left: number; right: number }, width: number, items: MenuItem[]): { place: ViewStyle; origin: string } {
  const host = { x: 0, y: 0, width: screen.width, height: screen.height };
  const spot = menuAt(at, host, insetRect(host, insets), width, tallestMenuPage(items), MENU_MARGIN);
  return { place: { left: spot.left, top: spot.top, width }, origin: spot.origin };
}

const widthOf = (place: ViewStyle) => (typeof place.width === "number" ? place.width : menuLook.width);

type FloatingProps = Omit<Props, "shown" | "origin"> & { anchor?: RefObject<ViewInstance | null>; at?: Point | null };

export function FloatingMenu({ items, place, onDismiss, anchor, at, dimmed, frost }: FloatingProps) {
  const hostFrame = useOverlayFrame();
  const insets = useSafeAreaInsets();
  const screen = useWindowDimensions();
  const frostAround = useMenuFrost();
  const width = widthOf(place);
  const [placed, setPlaced] = useState<{ place: ViewStyle; origin: string } | null>(() => (at ? menuAtPoint(at, screen, insets, width, items) : null));
  useEffect(() => {
    if (at) return;
    let live = true;
    void Promise.all([hostFrame(), anchor ? measureAnchor(anchor) : Promise.resolve(null)]).then(([host, row]) => {
      if (!live) return;
      const room = host.width > 0 ? insetRect(host, insets) : host;
      const height = tallestMenuPage(items);
      if (row && row.height > 0) {
        const spot = menuOnTrigger(row, host, room, width, height, MENU_MARGIN);
        setPlaced({ place: { width, left: spot.left, top: spot.top }, origin: spot.origin });
      } else if (typeof place.top === "number") {
        const top = Math.max(room.y + MENU_MARGIN, Math.min(place.top, room.y + room.height - height - MENU_MARGIN)) - host.y;
        setPlaced({ place: { ...place, width, top }, origin: "top" });
      } else setPlaced({ place: { ...place, width }, origin: place.bottom !== undefined ? "bottom" : "top" });
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <Portal>
      <Menu items={items} place={placed?.place ?? { ...place, width }} origin={placed?.origin ?? "top"} shown={placed !== null} dimmed={dimmed} frost={frost === undefined ? frostAround : frost} onDismiss={onDismiss} />
    </Portal>
  );
}

const styles = StyleSheet.create({
  panel: { position: "absolute", minWidth: menuLook.width, borderRadius: menuLook.radius, borderWidth: menuLook.rim },
  unseen: { opacity: 0 },
  material: { overflow: "hidden", paddingVertical: MENU_PADDING / 2 },
  specular: { position: "absolute", top: 0, left: 0, right: 0, height: 1 },
  row: { flexDirection: "row", alignItems: "center", marginHorizontal: PRESS, minHeight: MENU_ROW, paddingVertical: (MENU_ROW - menuLook.label.lineHeight) / 2, paddingRight: menuLook.labelInset - PRESS, borderRadius: MENU_ROW / 2 },
  chevronRoom: { paddingRight: menuLook.trailingInset - PRESS + menuLook.chevronSize + 8 },
  chevron: { position: "absolute", right: menuLook.trailingInset - PRESS, top: 0, bottom: 0, justifyContent: "center" },
  label: { flex: 1 },
  bold: { fontWeight: "600" },
  heading: { minHeight: MENU_HEADING, paddingTop: 8, paddingRight: menuLook.labelInset },
  divider: { height: MENU_DIVIDER, justifyContent: "center" },
  dividerLine: { height: menuLook.dividerLine, marginHorizontal: menuLook.dividerInset },
  check: { position: "absolute", left: menuLook.checkLeft - PRESS, top: 0, bottom: 0, justifyContent: "center" },
  iconSlot: { position: "absolute", width: menuLook.iconSlot, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: menuLook.disabledOpacity },
});
