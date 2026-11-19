import { actionSheet, ContextMenuView, nativeMenusAvailable, settingsUI, type MenuItem as NativeMenuItem } from "@ardia/phone-native";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { findNodeHandle, Platform, View, type GestureResponderEvent, type StyleProp, type ViewInstance, type ViewStyle } from "react-native";
import type { MenuAlign, Point } from "../../lib/menuPlace";
import { sfName } from "../../lib/sfSymbols";
import { focusForScreenReader } from "./coverFocus";
import { menuMotion } from "./motion";
import { useOverlayCovered } from "./Overlay";
import type { Confirmation } from "./Dialog";
import { FloatingMenu, isSubmenu, useMenuFloor, useMenuFrost, type MenuAction, type MenuItem, type MenuSubmenu } from "./Menu";
import { useTheme } from "./theme";

export type MenuHandlers = { onPress?: (event?: GestureResponderEvent) => void; onLongPress?: (event?: GestureResponderEvent) => void };

type Props = {
  items: MenuItem[];
  trigger?: "tap" | "longPress";
  fixedOrder?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  haptic?: () => void;
  disabled?: boolean;
  privately?: boolean;
  align?: MenuAlign;
  frost?: string | null;
  place?: ViewStyle;
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children: (handlers: MenuHandlers) => ReactNode;
};

export type NativeMenu = { items: NativeMenuItem[]; actions: Map<string, () => void> };

export const nativeMenus = () => Platform.OS === "ios" && nativeMenusAvailable().contextMenu;

export const spaceSystemImage = (name: string, icon: string | null): string | undefined => settingsUI.spaceMenuSymbol(name, icon) ?? undefined;

type Group = { title: string | null; items: NativeMenuItem[] };

export function nativeMenu(items: MenuItem[]): NativeMenu {
  const actions = new Map<string, () => void>();
  return { items: convert(items, "", actions), actions };
}

function convert(items: MenuItem[], prefix: string, actions: Map<string, () => void>): NativeMenuItem[] {
  const groups: Group[] = [{ title: null, items: [] }];
  items.forEach((item, index) => {
    const id = `${prefix}${index}`;
    if (item === "divider") groups.push({ title: null, items: [] });
    else if ("heading" in item) groups.push({ title: item.heading, items: [] });
    else groups[groups.length - 1]!.items.push(isSubmenu(item) ? submenu(item, id, actions) : action(item, id, actions));
  });
  const filled = groups.filter((group) => group.items.length > 0);
  if (filled.length === 1 && filled[0]!.title === null) return filled[0]!.items;
  return filled.map((group, at) => (group.title === null && at === 0 ? group.items : [{ id: `${prefix}g${at}`, title: group.title ?? "", inline: true, children: group.items }])).flat();
}

const image = (item: MenuAction | MenuSubmenu) => item.systemImage ?? sfName(item.icon);

function action(item: MenuAction, id: string, actions: Map<string, () => void>): NativeMenuItem {
  actions.set(id, item.onPress);
  return withoutEmpty({ id, title: item.label, systemImage: image(item), destructive: item.destructive, disabled: item.disabled, checked: item.checked });
}

function submenu(item: MenuSubmenu, id: string, actions: Map<string, () => void>): NativeMenuItem {
  return withoutEmpty({ id, title: item.label, systemImage: image(item), disabled: item.disabled, children: convert(item.children, `${id}.`, actions) });
}

const withoutEmpty = (item: NativeMenuItem): NativeMenuItem => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== false)) as NativeMenuItem;

let nativeMenuOpened: (privately: boolean) => void = () => undefined;

export const onNativeMenuOpened = (handler: (privately: boolean) => void) => {
  nativeMenuOpened = handler;
};

export function MenuTrigger(props: Props) {
  return nativeMenus() ? <NativeTrigger {...props} /> : <DrawnTrigger {...props} />;
}

function NativeTrigger({ items, trigger = "longPress", fixedOrder, onOpen, onClose, disabled, privately = false, dark, style, testID, children }: Props) {
  const theme = useTheme();
  const menu = nativeMenu(items);
  const actions = useRef(menu.actions);
  actions.current = menu.actions;
  const select = useCallback((id: string) => actions.current.get(id)?.(), []);
  const opened = useCallback(() => {
    nativeMenuOpened(privately);
    onOpen?.();
  }, [onOpen, privately]);
  return (
    <ContextMenuView testID={testID} style={style} collapsable={false} items={disabled ? [] : menu.items} trigger={trigger} fixedOrder={fixedOrder} onSelect={select} onOpen={opened} onClose={onClose} appearance={{ dark: dark ?? theme.dark }}>
      {children({})}
    </ContextMenuView>
  );
}

const pressPoint = (event?: GestureResponderEvent): Point | null => {
  const touch = event?.nativeEvent;
  return touch && typeof touch.pageX === "number" && typeof touch.pageY === "number" ? { x: touch.pageX, y: touch.pageY } : null;
};

function DrawnTrigger({ items, trigger = "longPress", onOpen, onClose, haptic, disabled = false, place, privately, align, frost: frostHere, style, testID, children }: Props) {
  const anchor = useRef<ViewInstance>(null);
  const opener = useRef<unknown>(null);
  const cancelRestore = useRef<() => void>(() => undefined);
  const covered = useOverlayCovered();
  useEffect(() => () => cancelRestore.current(), []);
  const frostAround = useMenuFrost();
  const frost = frostHere === undefined ? frostAround : frostHere;
  const floor = useMenuFloor();
  const [opened, setOpened] = useState<{ at: Point | null } | null>(null);
  useEffect(() => {
    if (!disabled) return;
    cancelRestore.current();
    if (!opened) return;
    setOpened(null);
    onClose?.();
  }, [disabled]);
  const open = useCallback(
    (event?: GestureResponderEvent) => {
      if (disabled) return;
      cancelRestore.current();
      haptic?.();
      opener.current = event?.currentTarget ?? null;
      setOpened({ at: trigger === "longPress" ? pressPoint(event) : null });
      onOpen?.();
    },
    [disabled, haptic, onOpen, trigger],
  );
  const dismiss = useCallback(
    (chosen?: boolean) => {
      setOpened(null);
      onClose?.();
      cancelRestore.current();
      if (chosen) return;
      let cancelFocus: () => void = () => undefined;
      const wait = setTimeout(() => {
        cancelFocus = focusForScreenReader(
          () => (opener.current ?? anchor.current) as Parameters<typeof findNodeHandle>[0],
          () => !covered(),
        );
      }, menuMotion.heldClose);
      cancelRestore.current = () => {
        clearTimeout(wait);
        cancelFocus();
        cancelRestore.current = () => undefined;
      };
    },
    [onClose],
  );
  const held = trigger === "longPress";
  return (
    <View ref={anchor} testID={testID} style={style} collapsable={false}>
      {children(held ? { onLongPress: open } : { onPress: open })}
      {opened && !disabled ? <FloatingMenu items={items} anchor={anchor} at={opened.at} floor={floor} align={align} place={place ?? {}} dimmed={held} privately={privately} frost={frost} onDismiss={dismiss} /> : null}
    </View>
  );
}

const nativeActionSheet = () => Platform.OS === "ios" && nativeMenusAvailable().actionSheet;

export function confirmInSheet(confirmation: Confirmation, drawn: () => void) {
  if (!nativeActionSheet()) {
    drawn();
    return;
  }
  void actionSheet({
    title: confirmation.title,
    message: confirmation.message,
    actions: [
      { id: "confirm", title: confirmation.action, destructive: confirmation.destructive !== false },
      { id: "cancel", title: "Cancel", cancel: true },
    ],
  }).then((chosen) => {
    if (chosen === "confirm") confirmation.run();
  });
}

