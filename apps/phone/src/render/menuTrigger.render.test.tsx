import { BackHandler, Platform, Pressable, Text } from "react-native";
import { act } from "react-test-renderer";
import { renderSurface, unmount } from "../../test/render/harness";
import { mockNative, resetNativeMenus } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { MenuTrigger, confirmInSheet, nativeMenu } = require("../components/ui/MenuTrigger") as typeof import("../components/ui/MenuTrigger");
const { FloatingMenu, Menu } = require("../components/ui/Menu") as typeof import("../components/ui/Menu");
type MenuItem = import("../components/ui").MenuItem;

type Root = ReturnType<typeof renderSurface>;

const ran: string[] = [];
const run = (name: string) => () => void ran.push(name);

const ITEMS: MenuItem[] = [
  { label: "Copy Link", icon: "link", onPress: run("copy") },
  { label: "Send to Device", children: [{ label: "Studio", icon: "laptop", systemImage: "desktopcomputer", onPress: run("studio") }, { label: "Pixel", icon: "iphone", onPress: run("pixel") }] },
  "divider",
  { heading: "Theme" },
  { label: "Light", checked: true, onPress: run("light") },
  { label: "Dark", disabled: true, onPress: run("dark") },
  "divider",
  { label: "Close Tab", destructive: true, onPress: run("close") },
];

const contextMenus = (root: Root) => root.root.findAll((node) => node.type === ("ContextMenuView" as never));
const menuLabels = (root: Root) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.type === "string").map((node) => node.props.accessibilityLabel);
const pickMenu = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());

function trigger(trigger: "tap" | "longPress") {
  return renderSurface(
    <MenuTrigger items={ITEMS} trigger={trigger} fixedOrder place={{ top: 100, left: 20, width: 250 }}>
      {({ onPress, onLongPress }) => (
        <Pressable accessibilityLabel="Trigger" onPress={onPress ?? (() => undefined)} onLongPress={onLongPress}>
          <Text>Trigger</Text>
        </Pressable>
      )}
    </MenuTrigger>,
  );
}

function pressBack() {
  const listening = jest.spyOn(BackHandler, "addEventListener");
  return () =>
    act(() => {
      const backs = listening.mock.calls.filter((call) => call[0] === "hardwareBackPress").map((call) => call[1]);
      for (const back of [...backs].reverse()) if (back({ type: "hardwareBackPress", timeStamp: 0 } as never)) break;
    });
}

beforeEach(() => {
  jest.useFakeTimers();
  ran.length = 0;
  resetNativeMenus();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("menu items become UIKit's: dividers split inline groups, a heading titles its group, submenus nest, icons become SF Symbols and flags carry over", () => {
  const { items, actions } = nativeMenu(ITEMS);
  expect(items).toEqual([
    { id: "0", title: "Copy Link", systemImage: "link" },
    {
      id: "1",
      title: "Send to Device",
      children: [
        { id: "1.0", title: "Studio", systemImage: "desktopcomputer" },
        { id: "1.1", title: "Pixel", systemImage: "iphone" },
      ],
    },
    { id: "g1", title: "Theme", inline: true, children: [{ id: "4", title: "Light", checked: true }, { id: "5", title: "Dark", disabled: true }] },
    { id: "g2", title: "", inline: true, children: [{ id: "7", title: "Close Tab", destructive: true }] },
  ]);
  for (const id of ["0", "1.0", "1.1", "4", "7"]) actions.get(id)!();
  expect(ran).toEqual(["copy", "studio", "pixel", "light", "close"]);
});

test("a menu with no dividers stays flat", () => {
  expect(nativeMenu([{ label: "One", onPress: run("one") }, { label: "Two", onPress: run("two") }]).items).toEqual([
    { id: "0", title: "One" },
    { id: "1", title: "Two" },
  ]);
});

test("on iPhone, with the system's menus, the trigger is a native context menu, by tap or long press, and choosing an item runs it", () => {
  if (Platform.OS !== "ios") return;
  mockNative.contextMenu = true;
  for (const kind of ["tap", "longPress"] as const) {
    const root = trigger(kind);
    const menu = contextMenus(root)[0]!;
    expect(menu.props.trigger).toBe(kind);
    expect(menu.props.fixedOrder).toBe(true);
    expect(menu.props.items.map((item: { title: string }) => item.title)).toEqual(["Copy Link", "Send to Device", "Theme", ""]);
    const pressable = root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && "onPress" in node.props)[0]!;
    expect(pressable.props.onLongPress).toBeUndefined();
    act(() => menu.props.onSelect("1.1"));
    expect(ran).toEqual(["pixel"]);
    ran.length = 0;
    unmount(root);
  }
});

test("Android never opens a system menu or action sheet, even where a native one would answer", async () => {
  if (Platform.OS !== "android") return;
  mockNative.contextMenu = true;
  mockNative.actionSheet = true;
  const root = trigger("tap");
  expect(contextMenus(root)).toHaveLength(0);
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(menuLabels(root)).toEqual(["Copy Link", "Send to Device", "Light", "Dark", "Close Tab"]);
  unmount(root);
  const drawn = jest.fn();
  confirmInSheet({ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: jest.fn() }, drawn);
  await act(async () => undefined);
  expect(drawn).toHaveBeenCalledTimes(1);
  expect(mockNative.sheets).toHaveLength(0);
});

test("a long press opens the drawn menu at the finger, dimmed, and a tap opens it beside its trigger, undimmed", () => {
  const held = trigger("longPress");
  act(() => held.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 120, pageY: 300 } }));
  const floating = held.root.findAll((node) => node.type === FloatingMenu)[0]!;
  expect(floating.props.at).toEqual({ x: 120, y: 300 });
  expect(floating.props.dimmed).toBe(true);
  const heldMenu = held.root.findAll((node) => node.type === Menu)[0]!;
  expect(heldMenu.props.shown).toBe(true);
  expect(heldMenu.props.place).toMatchObject({ left: 120, top: 300, width: 250 });
  expect(heldMenu.props.origin).toBe("left top");
  unmount(held);
  const tapped = renderSurface(
    <MenuTrigger items={ITEMS} trigger="tap" place={{ right: 16, width: 250 }}>
      {({ onPress }) => (
        <Pressable accessibilityLabel="Trigger" onPress={onPress}>
          <Text>Trigger</Text>
        </Pressable>
      )}
    </MenuTrigger>,
  );
  act(() => tapped.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress({ nativeEvent: { pageX: 300, pageY: 80 } }));
  const beside = tapped.root.findAll((node) => node.type === FloatingMenu)[0]!;
  expect(beside.props.at).toBeNull();
  expect(beside.props.anchor.current).not.toBeUndefined();
  expect(beside.props.dimmed).toBe(false);
  expect(tapped.root.findAll((node) => node.type === Menu)[0]!.props.shown).toBe(false);
  unmount(tapped);
});

test("Back closes the drawn menu, and on a submenu's page goes back to the menu first", () => {
  const back = pressBack();
  const root = trigger("tap");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  pickMenu(root, "Send to Device");
  expect(menuLabels(root)).toEqual(["Studio", "Pixel"]);
  back();
  expect(menuLabels(root)).toEqual(["Copy Link", "Send to Device", "Light", "Dark", "Close Tab"]);
  back();
  expect(menuLabels(root)).toEqual([]);
  expect(ran).toEqual([]);
  unmount(root);
});

test("the drawn menu reads as a menu: rows are menu items with their checked and disabled state, and a submenu's page has a way back", () => {
  const root = trigger("tap");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(root.root.findAll((node) => node.props.accessibilityRole === "menu" && typeof node.type !== "string")).not.toHaveLength(0);
  const row = (label: string) => root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && node.props.accessibilityLabel === label && typeof node.type === "string")[0]!;
  expect(row("Light").props.accessibilityState).toMatchObject({ checked: true });
  expect(row("Dark").props.accessibilityState).toMatchObject({ disabled: true });
  pickMenu(root, "Send to Device");
  const backRow = root.root.findAll((node) => node.props.accessibilityLabel === "Back, Send to Device" && typeof node.props.onPress === "function")[0]!;
  act(() => backRow.props.onPress());
  expect(menuLabels(root)).toContain("Copy Link");
  unmount(root);
});

test("each drawn menu and drawn action sheet counts drawn_menus_opened once as it opens", () => {
  const opened = jest.fn();
  const { onDrawnMenuOpened } = require("../components/ui/Menu") as typeof import("../components/ui/Menu");
  onDrawnMenuOpened(opened);
  const root = trigger("tap");
  const open = () => act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  open();
  expect(opened).toHaveBeenCalledTimes(1);
  pickMenu(root, "Send to Device");
  expect(opened).toHaveBeenCalledTimes(1);
  pickMenu(root, "Pixel");
  open();
  expect(opened).toHaveBeenCalledTimes(2);
  unmount(root);
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const sheet = renderSurface(<ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: jest.fn() }} onClose={jest.fn()} />);
  expect(opened).toHaveBeenCalledTimes(3);
  unmount(sheet);
  onDrawnMenuOpened(() => undefined);
});

test("the drawn confirmation is a centred card with one action and no Cancel row: its action confirms, and a tap outside, which never reaches what is under it, or Back cancels", () => {
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const back = pressBack();
  const confirmation = { title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: jest.fn() };
  const closed = jest.fn();
  const press = (root: Root, label: string) => act(() => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function")[0]!.props.onPress());
  const sheet = renderSurface(<ConfirmSheet confirmation={confirmation} onClose={closed} />);
  const text = sheet.root.findAll((node) => typeof node.type === "string" && typeof node.props.children === "string").map((node) => node.props.children).join("\n");
  expect(text).toContain("Close 3 Tabs?");
  expect(text).toContain("They’ll stay in your Archive.");
  const outside = sheet.root.findAll((node) => node.props.accessibilityLabel === "Cancel" && typeof node.props.onPress === "function" && node.props.accessibilityRole === "button");
  expect(outside).toHaveLength(1);
  expect(sheet.root.findAll((node) => typeof node.type === "string" && node.props.children === "Cancel")).toHaveLength(0);
  press(sheet, "Cancel");
  back();
  expect(closed).toHaveBeenCalledTimes(2);
  expect(confirmation.run).not.toHaveBeenCalled();
  press(sheet, "Close All Tabs");
  expect(closed).toHaveBeenCalledTimes(3);
  expect(confirmation.run).toHaveBeenCalledTimes(1);
  unmount(sheet);
});

test("without them the trigger opens the drawn menu on tap or long press, and a submenu opens as its own page", () => {
  const tapped = trigger("tap");
  expect(contextMenus(tapped)).toHaveLength(0);
  act(() => tapped.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(menuLabels(tapped)).toEqual(["Copy Link", "Send to Device", "Light", "Dark", "Close Tab"]);
  pickMenu(tapped, "Send to Device");
  expect(menuLabels(tapped)).toEqual(["Studio", "Pixel"]);
  pickMenu(tapped, "Studio");
  expect(ran).toEqual(["studio"]);
  expect(menuLabels(tapped)).toEqual([]);
  unmount(tapped);
  const held = trigger("longPress");
  act(() => held.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress());
  pickMenu(held, "Close Tab");
  expect(ran).toEqual(["studio", "close"]);
  unmount(held);
});

test("on iPhone a confirmation is the system's action sheet when there is one, and runs only when its action is chosen", async () => {
  if (Platform.OS !== "ios") return;
  const drawn = jest.fn();
  const confirmed = jest.fn();
  const confirmation = { title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: confirmed };
  confirmInSheet(confirmation, drawn);
  expect(drawn).toHaveBeenCalledTimes(1);
  expect(mockNative.sheets).toHaveLength(0);
  mockNative.actionSheet = true;
  confirmInSheet(confirmation, drawn);
  await act(async () => undefined);
  expect(mockNative.sheets[0]).toEqual({
    title: "Close 3 Tabs?",
    message: "They’ll stay in your Archive.",
    actions: [
      { id: "confirm", title: "Close All Tabs", destructive: true },
      { id: "cancel", title: "Cancel", cancel: true },
    ],
  });
  expect(confirmed).not.toHaveBeenCalled();
  mockNative.answer = "confirm";
  confirmInSheet(confirmation, drawn);
  await act(async () => undefined);
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect(drawn).toHaveBeenCalledTimes(1);
});
