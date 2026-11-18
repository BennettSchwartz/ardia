import { Platform, StyleSheet } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { StartScreen } from "../components/search/StartScreen";
import { materialStartMs } from "../components/search/MaterialStart";
import { Backdrop } from "../components/ui/Backdrop";
import { DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as browse from "../state/browse/store";
import { dismissSearch, presentSearch } from "../state/search/store";
import { useTabs } from "../state/tabs/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(0);
  setDynamicScheme(null);
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  act(() => useTabs.setState({ incognito: false }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const pressable = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.props.onPress === "function")[0]!;
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};

const start = () =>
  renderSurface(
    <DesignProvider design="material">
      <StartScreen />
    </DesignProvider>,
  );

onAndroid("the material start screen is the scheme's surfaces, a top app bar of 48 dp icon buttons, the logo, and a 56 dp Material search bar at the bottom", () => {
  const root = start();
  expect(node(root, "materialStart")).toBeDefined();
  expect(root.root.findAll((found) => found.type === Backdrop)[0]!.props.colors).toEqual([LIGHT.surface, LIGHT.surfaceContainerLow]);
  for (const label of ["Archive", "New Incognito Tab", "Settings"]) {
    expect(flat(node(root, `materialStart:${label}`))).toMatchObject({ width: 48, height: 48 });
    expect(pressable(root, `materialStart:${label}`).props.android_ripple).toMatchObject({ borderless: true });
  }
  expect(flat(node(root, "materialStartSearch"))).toMatchObject({ height: 56, borderRadius: 9999, backgroundColor: LIGHT.surfaceContainerHigh });
  expect(pressable(root, "materialStartSearch").props.android_ripple).toMatchObject({ borderless: false });
  expect(node(root, "startDeckBar")).toBeUndefined();
  unmount(root);
});

onAndroid("the search bar opens a new tab's search, and the bar's buttons are the plus menu's actions laid out where they can be seen", () => {
  const tab = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const incognito = jest.spyOn(browse, "newIncognitoTab").mockImplementation(() => undefined);
  const archive = jest.spyOn(browse, "openArchive").mockImplementation(() => undefined);
  const root = start();
  act(() => {
    pressable(root, "materialStartSearch").props.onPress();
  });
  act(() => {
    pressable(root, "materialStart:New Incognito Tab").props.onPress();
  });
  act(() => {
    pressable(root, "materialStart:Archive").props.onPress();
  });
  expect(tab).toHaveBeenCalled();
  expect(incognito).toHaveBeenCalled();
  expect(archive).toHaveBeenCalled();
  unmount(root);
});

onAndroid("with tabs open the leading button is Tabs, and it shows the deck", () => {
  withTabs(2);
  act(() => browse.useBrowse.setState({ surface: "start", sheet: null }));
  const deck = jest.spyOn(browse, "showDeck").mockImplementation(() => Promise.resolve());
  const root = start();
  act(() => {
    pressable(root, "materialStart:Tabs").props.onPress();
  });
  expect(deck).toHaveBeenCalled();
  unmount(root);
});

onAndroid("in Incognito the start screen is the scheme's inverse surface and says so", () => {
  act(() => useTabs.setState({ incognito: true }));
  const root = start();
  expect(flat(node(root, "materialStartBackdrop")).backgroundColor).toBe(LIGHT.inverseSurface);
  expect(root.root.findAll((found) => found.props.children === "You’re browsing Incognito").length).toBeGreaterThan(0);
  expect(node(root, "materialStart:New Tab")).toBeDefined();
  unmount(root);
});

onAndroid("while search is open the start screen's controls leave touch and TalkBack, and they fade through on Material's timings", () => {
  const root = start();
  act(() => presentSearch("start", ""));
  for (const id of ["materialStartTopBar", "materialStartBottom"]) {
    expect(node(root, id)!.props).toMatchObject({ pointerEvents: "none", importantForAccessibility: "no-hide-descendants", accessibilityElementsHidden: true });
  }
  expect(materialStartMs(true, true)).toBe(0);
  expect(materialStartMs(false, true)).toBe(100);
  expect(materialStartMs(false, false)).toBe(250);
  unmount(root);
});
