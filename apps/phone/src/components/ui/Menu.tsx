import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { BackHandler, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle, type ViewInstance } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { insetRect, MENU_DIVIDER, MENU_HEADING, MENU_MARGIN, MENU_PADDING, MENU_ROW, menuAcross, menuAt, menuBeside, tallestMenuPage, type Point } from "../../lib/menuPlace";
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

type Props = { items: MenuItem[]; place: ViewStyle; onDismiss: () => void; dimmed?: boolean; origin?: string; frost?: string | null };

export function Menu({ items, place, onDismiss, dimmed = false, origin = "top", frost }: Props) {
  const theme = useTheme();
  const paint = theme.dark ? menuInk.dark : menuInk.light;
  const reduceMotion = useReduceMotion();
  const frostAround = useMenuFrost();
  const source = frost === undefined ? frostAround : frost;
  const [page, setPage] = useState<MenuSubmenu | null>(null);
  const shown = page ? page.children : items;
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
    opened.value = reduceMotion ? 1 : withSpring(1, menuMotion.open);
  }, []);
  const grow = useAnimatedStyle(() => ({
    opacity: Math.min(1, opened.value / menuMotion.opaqueAt),
    transform: [{ scale: menuMotion.fromScale + (1 - menuMotion.fromScale) * opened.value }],
  }));
  const checks = shown.some((item) => typeof item === "object" && !("heading" in item) && !isSubmenu(item) && item.checked === true);
  const leading = menuLook.iconSide === "leading";
  const rows = shown.map((item, index) => {
    const before = shown[index - 1];
    const separated = menuLook.rowSeparators && index > 0 && before !== "divider" && typeof before === "object" && !("heading" in before) && item !== "divider" && !("heading" in item);
    const separator = separated ? <View style={[styles.separator, { backgroundColor: paint.separator }]} /> : null;
    if (item === "divider") return <View key={`d${index}`} style={[styles.divider, { backgroundColor: paint.groupSeparator }]} />;
    if ("heading" in item)
      return (
        <Text key={`h${index}`} accessibilityRole="header" style={[font.footnote, styles.heading, { color: paint.heading }]}>
          {item.heading}
        </Text>
      );
    if (isSubmenu(item))
      return (
        <Fragment key={`${index}:${item.label}`}>
          {separator}
          <Pressable
            accessibilityRole="menuitem"
            accessibilityLabel={item.label}
            accessibilityState={{ disabled: item.disabled, expanded: false }}
            disabled={item.disabled}
            onPress={() => setPage(item)}
            style={({ pressed }) => [styles.row, pressed ? { backgroundColor: paint.highlight } : null, item.disabled ? styles.disabled : null]}
          >
            {checks ? <View style={styles.checkSlot} /> : null}
            {leading && item.icon ? <MenuIcon name={item.icon} color={theme.label} /> : null}
            <Text numberOfLines={menuLook.labelLines} style={[font.body, styles.label, { color: theme.label }]}>
              {item.label}
            </Text>
            <MenuIcon name="chevronRight" color={theme.label} />
          </Pressable>
        </Fragment>
      );
    const color = item.destructive ? theme.destructive : theme.label;
    return (
      <Fragment key={`${index}:${item.label}`}>
        {separator}
        <Pressable
          accessibilityRole="menuitem"
          accessibilityLabel={item.label}
          accessibilityState={{ checked: item.checked, disabled: item.disabled }}
          disabled={item.disabled}
          onPress={() => {
            onDismiss();
            item.onPress();
          }}
          style={({ pressed }) => [styles.row, pressed ? { backgroundColor: paint.highlight } : null, item.disabled ? styles.disabled : null]}
        >
          {checks ? <View style={styles.checkSlot}>{item.checked ? <Symbol name="checkmark" size={menuLook.checkSize} color={color} /> : null}</View> : null}
          {leading && item.icon ? <MenuIcon name={item.icon} color={color} /> : null}
          <Text numberOfLines={menuLook.labelLines} style={[font.body, styles.label, { color }]}>
            {item.label}
          </Text>
          {!leading && item.icon ? <MenuIcon name={item.icon} color={color} /> : null}
        </Pressable>
      </Fragment>
    );
  });
  return (
    <Animated.View style={StyleSheet.absoluteFill} exiting={reduceMotion ? undefined : FadeOut.duration(menuMotion.close)}>
      <Animated.View entering={dimmed && !reduceMotion ? FadeIn.duration(menuMotion.dim) : undefined} style={StyleSheet.absoluteFill}>
        <Pressable accessibilityLabel="Dismiss" style={[StyleSheet.absoluteFill, { backgroundColor: dimmed ? theme.menuScrim : ink.clear }]} onPress={onDismiss} />
      </Animated.View>
      <Animated.View
        ref={panel}
        testID="drawnMenu"
        accessibilityRole="menu"
        accessibilityViewIsModal
        style={[styles.panel, { boxShadow: `0px 8px 32px ${paint.shadow}`, transformOrigin: origin }, place, grow]}
      >
        <MenuMaterial source={source} fill={paint.fill} solid={paint.solid} radius={menuLook.radius} style={styles.frost}>
          {page ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Back, ${page.label}`}
              onPress={() => setPage(null)}
              style={({ pressed }) => [styles.row, styles.back, pressed ? { backgroundColor: paint.highlight } : null, { borderBottomColor: paint.separator }]}
            >
              <MenuIcon name="chevronLeft" color={theme.label} />
              <Text numberOfLines={1} style={[font.body, styles.label, styles.backLabel, { color: theme.label }]}>
                {page.label}
              </Text>
            </Pressable>
          ) : null}
          {rows}
        </MenuMaterial>
      </Animated.View>
    </Animated.View>
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

function MenuIcon({ name, color }: { name: SymbolName; color: string }) {
  return (
    <View style={styles.iconSlot}>
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

type FloatingProps = Props & { anchor?: RefObject<ViewInstance | null>; at?: Point | null };

export function FloatingMenu({ items, place, onDismiss, anchor, at, dimmed, frost }: FloatingProps) {
  const hostFrame = useOverlayFrame();
  const insets = useSafeAreaInsets();
  const frostAround = useMenuFrost();
  const [placed, setPlaced] = useState<{ place: ViewStyle; origin: string } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([hostFrame(), anchor && !at ? measureAnchor(anchor) : Promise.resolve(null)]).then(([host, row]) => {
      if (!live) return;
      const room = host.width > 0 ? insetRect(host, insets) : host;
      const height = tallestMenuPage(items);
      const width = widthOf(place);
      const { top: _top, bottom: _bottom, ...across } = place;
      if (at) {
        const spot = menuAt(at, host, room, width, height, MENU_MARGIN);
        setPlaced({ place: { width, left: spot.left, top: spot.top }, origin: spot.origin });
      } else if (row && row.height > 0) {
        const beside = menuBeside(row, host, room, height, MENU_MARGIN);
        const sideways = across.left !== undefined || across.right !== undefined ? {} : { width, left: menuAcross(row, host, room, width, MENU_MARGIN) };
        setPlaced({ place: { ...across, ...sideways, top: beside.top }, origin: beside.below ? "top" : "bottom" });
      } else if (typeof place.top === "number") {
        const top = Math.max(room.y + MENU_MARGIN, Math.min(place.top, room.y + room.height - height - MENU_MARGIN)) - host.y;
        setPlaced({ place: { ...place, top }, origin: "top" });
      } else setPlaced({ place, origin: place.bottom !== undefined ? "bottom" : "top" });
    });
    return () => {
      live = false;
    };
  }, []);
  return placed ? (
    <Portal>
      <Menu items={items} place={placed.place} origin={placed.origin} dimmed={dimmed} frost={frost === undefined ? frostAround : frost} onDismiss={onDismiss} />
    </Portal>
  ) : null;
}

const styles = StyleSheet.create({
  panel: { position: "absolute", minWidth: menuLook.width, borderRadius: menuLook.radius },
  frost: { overflow: "hidden", paddingVertical: MENU_PADDING / 2 },
  row: { flexDirection: "row", alignItems: "center", gap: menuLook.labelGap, paddingHorizontal: menuLook.sideInset, minHeight: MENU_ROW },
  back: { borderBottomWidth: StyleSheet.hairlineWidth },
  backLabel: { fontWeight: "600" },
  label: { flex: 1 },
  heading: { paddingHorizontal: menuLook.sideInset, minHeight: MENU_HEADING, paddingTop: 6 },
  separator: { height: StyleSheet.hairlineWidth },
  divider: { height: MENU_DIVIDER },
  checkSlot: { width: menuLook.checkSlot, alignItems: "center" },
  iconSlot: { width: menuLook.iconSlot, alignItems: "center" },
  disabled: { opacity: menuLook.disabledOpacity },
});
