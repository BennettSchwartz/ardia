import { BackHandler, Platform, Pressable, Text } from "react-native";
import { act } from "react-test-renderer";
import { renderSurface, unmount } from "../../test/render/harness";
import { mockNative, resetNativeMenus } from "./nativeMenusMock";

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const { MenuTrigger, confirmInSheet, nativeMenu } = require("../components/ui/MenuTrigger") as typeof import("../components/ui/MenuTrigger");
const { FloatingMenu, Menu, menuExitMs } = require("../components/ui/Menu") as typeof import("../components/ui/Menu");
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
  expect(heldMenu.props.placer(200)).toMatchObject({ place: { left: 120, top: 300, width: 250 }, origin: "left top", maxHeight: 200 });
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
  act(() => jest.advanceTimersByTime(menuExitMs(true)));
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
  act(() => jest.advanceTimersByTime(menuExitMs(true)));
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

const RECENT: MenuItem[] = [...Array.from({ length: 8 }, (_, at): MenuItem => ({ label: `Tab ${at}`, onPress: run(`tab${at}`) })), "divider", { label: "Close Tab", destructive: true, onPress: run("close") }];

test("a menu taller than a landscape screen is cut to the safe room and its rows scroll, so the last one stays reachable", () => {
  const { pointPlacer } = require("../components/ui") as typeof import("../components/ui");
  const placer = pointPlacer({ x: 400, y: 300 }, { width: 873, height: 392 }, { top: 24, bottom: 24, left: 0, right: 0 }, 250);
  const root = renderSurface(<Menu items={RECENT} placer={placer} onDismiss={() => undefined} />);
  const panel = root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")[0]!;
  const style = require("react-native").StyleSheet.flatten(panel.props.style);
  expect(style.top).toBeGreaterThanOrEqual(32);
  expect(style.top + style.maxHeight).toBeLessThanOrEqual(360);
  const rows = root.root.findAll((node) => node.props.testID === "drawnMenuRows" && typeof node.props.onContentSizeChange === "function")[0]!;
  expect(rows.findAll((node) => node.props.accessibilityLabel === "Close Tab" && typeof node.props.onPress === "function")).not.toHaveLength(0);
  act(() => rows.props.onContentSizeChange(250, 500));
  const measured = require("react-native").StyleSheet.flatten(root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")[0]!.props.style);
  expect(measured.maxHeight).toBe(328);
  expect(measured.top + measured.maxHeight).toBeLessThanOrEqual(360);
  unmount(root);
});

const rowsOf = (root: Root) => root.root.findAll((node) => node.props.testID === "drawnMenuRows" && typeof node.props.onContentSizeChange === "function")[0]!;
const panelOf = (root: Root) => root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")[0]!;
const flat = (style: unknown) => require("react-native").StyleSheet.flatten(style);
const setWindow = (window: object) => act(() => (require("react-native").Dimensions as { set: (dims: object) => void }).set({ window, screen: window }));

test("a placed menu stays hidden until its rows are measured, then shows where they fit, so it never jumps across the finger", () => {
  const { pointPlacer } = require("../components/ui") as typeof import("../components/ui");
  const placer = pointPlacer({ x: 60, y: 600 }, { width: 393, height: 873 }, { top: 40, bottom: 24, left: 0, right: 0 }, 250);
  const five: MenuItem[] = Array.from({ length: 5 }, (_, at): MenuItem => ({ label: `Row ${at}`, onPress: run(`row${at}`) }));
  const root = renderSurface(<Menu items={five} placer={placer} onDismiss={() => undefined} />);
  expect(flat(panelOf(root).props.style).opacity).toBe(0);
  const hiddenLayer = () => root.root.findAll((node) => typeof node.type === "string" && node.props.pointerEvents === "none" && node.props.accessibilityElementsHidden === true);
  expect(hiddenLayer()).toHaveLength(1);
  act(() => rowsOf(root).props.onContentSizeChange(250, 300));
  const shown = flat(panelOf(root).props.style);
  expect(shown.opacity).not.toBe(0);
  expect(hiddenLayer()).toHaveLength(0);
  expect(shown.top).toBe(600 - 16 - 301);
  unmount(root);
});

test("when a submenu's page is taller, the menu re-measures and stays on its side of the finger", () => {
  const { pointPlacer } = require("../components/ui") as typeof import("../components/ui");
  const placer = pointPlacer({ x: 60, y: 500 }, { width: 393, height: 873 }, { top: 40, bottom: 24, left: 0, right: 0 }, 250);
  const root = renderSurface(<Menu items={ITEMS} placer={placer} onDismiss={() => undefined} />);
  act(() => rowsOf(root).props.onContentSizeChange(250, 250));
  expect(flat(panelOf(root).props.style).top).toBe(500);
  pickMenu(root, "Send to Device");
  act(() => rowsOf(root).props.onContentSizeChange(250, 420));
  const page = flat(panelOf(root).props.style);
  expect(page.top).toBeLessThan(500);
  expect(page.top).toBe(841 - 421);
  expect(page.top + page.maxHeight).toBeLessThanOrEqual(841);
  unmount(root);
});

test("turning the phone closes an open drawn menu, as UIKit's do, but the keyboard coming up does not", () => {
  const { Dimensions } = require("react-native") as typeof import("react-native");
  const before = Dimensions.get("window");
  const closed = jest.fn();
  const root = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} onDismiss={closed} />);
  setWindow({ ...before, height: before.height - 300 });
  expect(closed).not.toHaveBeenCalled();
  setWindow(before);
  setWindow({ ...before, width: before.height, height: before.width });
  expect(closed).toHaveBeenCalledTimes(1);
  setWindow(before);
  unmount(root);
});

test("a chosen row runs at once, and only once however often it is tapped, while the menu plays its close", () => {
  const closed = jest.fn();
  const chosen = jest.fn();
  const root = renderSurface(<Menu items={[{ label: "Close Tab", destructive: true, onPress: chosen }]} place={{ top: 100, left: 20, width: 250 }} onDismiss={closed} />);
  const row = root.root.findAll((node) => node.props.accessibilityRole === "menuitem" && typeof node.props.onPress === "function")[0]!;
  act(() => row.props.onPress());
  expect(chosen).toHaveBeenCalledTimes(1);
  act(() => row.props.onPress());
  expect(chosen).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(1000));
  expect(chosen).toHaveBeenCalledTimes(1);
  unmount(root);
});

test("rows scroll under a tap with the keyboard up, in the menu and in the confirmation", () => {
  const root = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} onDismiss={() => undefined} />);
  expect(rowsOf(root).props.keyboardShouldPersistTaps).toBe("handled");
  unmount(root);
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const sheet = renderSurface(<ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={() => undefined} />);
  expect(sheet.root.findAll((node) => node.props.testID === "drawnConfirmationScroll" && typeof node.type !== "string")[0]!.props.keyboardShouldPersistTaps).toBe("handled");
  unmount(sheet);
});

test("TalkBack moves to the first enabled row once the menu is shown, and back to the control that opened it only when the menu is dismissed without a choice", () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => undefined);
  const hidden = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} shown={false} onDismiss={() => undefined} />);
  expect(asked).not.toHaveBeenCalled();
  unmount(hidden);
  const shown = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} onDismiss={() => undefined} />);
  expect(asked).toHaveBeenCalledTimes(1);
  unmount(shown);
  const opener = { opener: true };
  const restored = () => asked.mock.calls.filter(([target]) => target() === opener).length;
  const back = pressBack();
  const root = trigger("tap");
  const open = () => act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress({ currentTarget: opener, nativeEvent: {} }));
  open();
  back();
  act(() => jest.advanceTimersByTime(1000));
  expect(restored()).toBe(1);
  open();
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Dismiss" && typeof node.props.onPress === "function")[0]!.props.onPress({ nativeEvent: {} }));
  act(() => jest.advanceTimersByTime(1000));
  expect(restored()).toBe(2);
  open();
  pickMenu(root, "Copy Link");
  act(() => jest.advanceTimersByTime(1000));
  expect(restored()).toBe(2);
  open();
  back();
  unmount(root);
  act(() => jest.advanceTimersByTime(1000));
  expect(restored()).toBe(2);
});

test("a TalkBack focus asked for as the menu opens is dropped once the menu starts closing, so it never lands on a closing row", () => {
  const focus = require("../components/ui/coverFocus") as typeof import("../components/ui/coverFocus");
  const asked = jest.spyOn(focus, "focusForScreenReader").mockImplementation(() => undefined);
  const back = pressBack();
  const root = trigger("longPress");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onLongPress === "function")[0]!.props.onLongPress({ nativeEvent: { pageX: 120, pageY: 300 } }));
  act(() => rowsOf(root).props.onContentSizeChange(250, 200));
  expect(asked).toHaveBeenCalledTimes(1);
  const still = asked.mock.calls[0]![1]!;
  expect(still()).toBe(true);
  back();
  expect(still()).toBe(false);
  act(() => jest.advanceTimersByTime(1000));
  unmount(root);
});

test("an Incognito card's native menu on iPhone is not counted either", () => {
  if (Platform.OS !== "ios") return;
  mockNative.contextMenu = true;
  const { onNativeMenuOpened } = require("../components/ui/MenuTrigger") as typeof import("../components/ui/MenuTrigger");
  const opened = jest.fn();
  onNativeMenuOpened(opened);
  const root = renderSurface(
    <MenuTrigger items={ITEMS} trigger="longPress" privately>
      {() => <Text>Card</Text>}
    </MenuTrigger>,
  );
  act(() => contextMenus(root)[0]!.props.onOpen());
  expect(opened).toHaveBeenCalledWith(true);
  unmount(root);
  const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const { countNativeMenu } = require("../state/browse/menuCounts") as typeof import("../state/browse/menuCounts");
  const { useTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");
  act(() => useTabs.setState({ incognito: false }));
  countNativeMenu(true);
  expect(counted).not.toHaveBeenCalled();
  countNativeMenu(false);
  expect(counted).toHaveBeenCalledWith("native_menus_opened");
  onNativeMenuOpened(() => undefined);
});

test("drawn_menus_opened is never counted while browsing privately: on the deck's Incognito side, on an Incognito page, or for an Incognito card's menu", () => {
  const telemetry = require("../state/telemetry/telemetry") as typeof import("../state/telemetry/telemetry");
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const { countDrawnMenu } = require("../state/browse/menuCounts") as typeof import("../state/browse/menuCounts");
  const { useTabs } = require("../state/tabs/store") as typeof import("../state/tabs/store");
  const { useBrowse } = require("../state/browse/store") as typeof import("../state/browse/store");
  const { launchTabs } = require("../state/tabs/tabsState") as typeof import("../state/tabs/tabsState");
  const { someTabs } = require("../../test/render/harness") as typeof import("../../test/render/harness");
  const privateTab = someTabs(1, true)[0]!;
  act(() => {
    useTabs.setState({ ...launchTabs(someTabs(2), 0), incognito: false, listing: 0 });
    useBrowse.setState({ surface: "deck" });
  });
  countDrawnMenu(false);
  expect(counted).toHaveBeenCalledTimes(1);
  countDrawnMenu(true);
  expect(counted).toHaveBeenCalledTimes(1);
  act(() => useTabs.setState({ incognito: true }));
  countDrawnMenu(false);
  expect(counted).toHaveBeenCalledTimes(1);
  act(() => {
    useTabs.setState((state) => ({ ...state, incognito: false, privates: [privateTab], selectedId: privateTab.id }));
    useBrowse.setState({ surface: "browsing" });
  });
  countDrawnMenu(false);
  expect(counted).toHaveBeenCalledTimes(1);
  expect(counted).toHaveBeenCalledWith("drawn_menus_opened");
  const { onDrawnMenuOpened } = require("../components/ui/Menu") as typeof import("../components/ui/Menu");
  const opened = jest.fn();
  onDrawnMenuOpened(opened);
  const root = renderSurface(<Menu items={ITEMS} place={{ top: 100, left: 20, width: 250 }} privately onDismiss={() => undefined} />);
  expect(opened).toHaveBeenCalledWith(true);
  unmount(root);
  onDrawnMenuOpened(() => undefined);
});

test("a confirmation's button labels wrap instead of truncating, and the card grows with the text size up to the screen's width", () => {
  const { ConfirmSheet, confirmCardWidth } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  expect(confirmCardWidth(1, 393)).toBeCloseTo(240.3);
  expect(confirmCardWidth(1.5, 393)).toBeCloseTo(360.45);
  expect(confirmCardWidth(2, 393)).toBe(361);
  const sheet = renderSurface(<ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={() => undefined} />);
  const label = sheet.root.findAll((node) => typeof node.type === "string" && node.props.children === "Close All Tabs")[0]!;
  expect(label.props.numberOfLines).toBeUndefined();
  const button = sheet.root.findAll((node) => node.props.accessibilityLabel === "Close All Tabs" && typeof node.type === "string")[0]!;
  const style = require("react-native").StyleSheet.flatten(button.props.style);
  expect(style.height).toBeUndefined();
  expect(style.minHeight).toBe(43.5);
  unmount(sheet);
});

const covered = (root: Root) => root.root.findAll((node) => node.props.testID === "overlayCovered" && typeof node.type === "string")[0]!.props;

test("a closed menu stays drawn for its close, out of the way of touches and TalkBack, and goes when the close ends", () => {
  const root = trigger("tap");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Trigger" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(covered(root).importantForAccessibility).toBe("no-hide-descendants");
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "Dismiss" && typeof node.props.onPress === "function")[0]!.props.onPress());
  expect(root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")).toHaveLength(1);
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.pointerEvents === "none" && node.props.accessibilityElementsHidden === true)).not.toHaveLength(0);
  expect(covered(root).importantForAccessibility).toBe("auto");
  act(() => jest.advanceTimersByTime(menuExitMs(false)));
  expect(root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")).toHaveLength(0);
  unmount(root);
});

test("a row that opens a confirmation shows the card alone: the closing menu is dropped at once, and the app behind is hidden from TalkBack", () => {
  const { ConfirmSheet } = require("../components/ui/ActionSheet") as typeof import("../components/ui/ActionSheet");
  const { useState } = require("react") as typeof import("react");
  function Asking() {
    const [asking, setAsking] = useState(false);
    return (
      <>
        <MenuTrigger items={[{ label: "Close All Tabs", destructive: true, onPress: () => setAsking(true) }]} trigger="tap">
          {({ onPress }) => (
            <Pressable accessibilityLabel="More" onPress={onPress}>
              <Text>More</Text>
            </Pressable>
          )}
        </MenuTrigger>
        {asking ? <ConfirmSheet confirmation={{ title: "Close 3 Tabs?", message: "They’ll stay in your Archive.", action: "Close All Tabs", run: () => undefined }} onClose={() => setAsking(false)} /> : null}
      </>
    );
  }
  const root = renderSurface(<Asking />);
  act(() => root.root.findAll((node) => node.props.accessibilityLabel === "More" && typeof node.props.onPress === "function")[0]!.props.onPress());
  pickMenu(root, "Close All Tabs");
  expect(root.root.findAll((node) => node.props.testID === "drawnActionSheet" && typeof node.type === "string")).toHaveLength(1);
  expect(root.root.findAll((node) => node.props.testID === "drawnMenu" && typeof node.type === "string")).toHaveLength(0);
  expect(covered(root).importantForAccessibility).toBe("no-hide-descendants");
  unmount(root);
});
