import { Platform, ScrollView, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SettingsView } from "../components/settings/SettingsView";
import { materialAppBarFill } from "../components/settings/MaterialSettingsKit";
import { DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as settingsActions from "../state/settings/actions";
import { closeSettings, openSettings, pushSettings, useSettingsNav } from "../state/settings/nav";
import { classicOnAndroid, renderSurface, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  setDynamicScheme(null);
  openSettings();
});

afterEach(() => {
  act(() => closeSettings());
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const pressable = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.props.onPress === "function")[0]!;
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};

const settings = () =>
  renderSurface(
    <DesignProvider design="material">
      <SettingsView />
    </DesignProvider>,
  );

onAndroid("Settings in the material design opens on a Material top app bar: 64 dp on surface, the title in titleLarge, and no iOS chevrons on its rows", () => {
  const root = settings();
  expect(flat(node(root, "materialSettingsPage")).backgroundColor).toBe(LIGHT.surface);
  const bar = node(root, "materialTopAppBar")!;
  expect(flat(bar).backgroundColor).toBe(LIGHT.surface);
  expect(flat(bar.findAll((found) => typeof found.type === "string" && flat(found).minHeight === 64)[0])).toMatchObject({ minHeight: 64 });
  expect(flat(node(root, "settingsTitle"))).toMatchObject({ fontSize: 22, color: LIGHT.onSurface });
  const row = node(root, "materialSettingsRow:Search Engine")!;
  expect(flat(row).minHeight).toBeGreaterThanOrEqual(56);
  expect(pressable(root, "materialSettingsRow:Search Engine").props.android_ripple).toMatchObject({ borderless: false });
  expect(row.findAll((found) => found.props.name === "chevronRight")).toHaveLength(0);
  unmount(root);
});

onAndroid("the app bar takes surfaceContainer once the list scrolls under it, as Material's top app bar does", () => {
  const root = settings();
  const list = root.root.findAll((found) => found.type === ScrollView)[0]!;
  act(() => list.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 80 } } }));
  expect(flat(node(root, "materialTopAppBar")).backgroundColor).toBe(LIGHT.surfaceContainer);
  expect(materialAppBarFill(LIGHT, false)).toBe(LIGHT.surface);
  unmount(root);
});

onAndroid("groups are flat sections split by full-width outlineVariant dividers, with no row dividers inside", () => {
  const root = settings();
  const dividers = root.root.findAll((found) => found.props.testID === "materialSettingsDivider" && typeof found.type === "string");
  expect(dividers.length).toBeGreaterThan(2);
  for (const divider of dividers) expect(flat(divider)).toMatchObject({ height: 1, backgroundColor: LIGHT.outlineVariant });
  expect(dividers.every((divider) => !flat(divider).marginLeft)).toBe(true);
  unmount(root);
});

onAndroid("switch rows are one switch for TalkBack with a Material switch inside, and a tap anywhere flips them", () => {
  const set = jest.spyOn(settingsActions, "setSearchSuggestions").mockImplementation(() => undefined as never);
  const root = settings();
  const row = pressable(root, "materialSettingsRow:Search Suggestions");
  expect(row.props.accessibilityRole).toBe("switch");
  expect(row.findAll((found) => found.props.testID === "materialSwitch" && typeof found.type === "string")).toHaveLength(1);
  const checked = row.props.accessibilityState.checked;
  act(() => {
    row.props.onPress();
  });
  expect(set).toHaveBeenCalledWith(!checked);
  unmount(root);
});

onAndroid("a picker row shows its choice as supporting text and opens a Material dialog with a radio list; picking closes it and applies", () => {
  const set = jest.spyOn(settingsActions, "setArchiveInterval").mockImplementation(() => undefined as never);
  const root = settings();
  act(() => {
    pressable(root, "materialSettingsRow:Archive Inactive Tabs").props.onPress();
  });
  expect(node(root, "materialDialog")).toBeDefined();
  const radios = node(root, "materialRadioList")!.findAll((found) => typeof found.type === "string" && found.props.accessibilityRole === "radio");
  expect(radios.length).toBeGreaterThan(1);
  expect(radios.filter((radio) => radio.props.accessibilityState.selected)).toHaveLength(1);
  const other = radios.find((radio) => !radio.props.accessibilityState.selected)!;
  for (const radio of radios) expect(flat(radio).minHeight).toBeGreaterThanOrEqual(48);
  act(() => {
    pressable(root, other.props.testID).props.onPress();
  });
  expect(set).toHaveBeenCalledTimes(1);
  expect(node(root, "materialDialog")).toBeUndefined();
  unmount(root);
});

onAndroid("a pushed page carries a 48 dp back arrow in the app bar", () => {
  act(() => pushSettings({ page: "about" }));
  const root = settings();
  expect(useSettingsNav.getState().stack.length).toBe(2);
  expect(flat(node(root, "materialSettingsBack"))).toMatchObject({ width: 48, height: 48 });
  expect(pressable(root, "materialSettingsBack").props.android_ripple).toMatchObject({ borderless: true });
  unmount(root);
});

onAndroid("the original design's Settings are untouched by the Material one", () => {
  const root = renderSurface(classicOnAndroid(<SettingsView />));
  expect(node(root, "materialSettingsPage")).toBeUndefined();
  expect(node(root, "materialSwitch")).toBeUndefined();
  unmount(root);
});
