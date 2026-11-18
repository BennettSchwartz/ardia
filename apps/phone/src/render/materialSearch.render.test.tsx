import { Platform, StyleSheet, Text } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { materialSearchMs } from "../components/search/MaterialSearchView";
import { DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as browse from "../state/browse/store";
import { history } from "../state/history/store";
import { dismissSearch, presentSearch, searchState, typeSearch } from "../state/search/store";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { useTabs } from "../state/tabs/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;
let revision = 5000;

beforeEach(() => {
  jest.useFakeTimers();
  revision += 1;
  jest.spyOn(history(), "summary").mockImplementation(() => [
    { url: "https://www.google.com/search?q=otters", title: "otters - Google Search", favicon: null, visits: 3, lastVisit: 1 },
    { url: "https://www.google.com/search?q=sintra", title: "sintra - Google Search", favicon: null, visits: 2, lastVisit: 2 },
  ]);
  jest.spyOn(history(), "revision").mockImplementation(() => revision);
  withTabs(2);
  setDynamicScheme(null);
  act(() => {
    browse.useBrowse.setState({ surface: "start" });
    useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } as never }));
  });
});

afterEach(() => {
  act(() => dismissSearch());
  act(() => jest.runOnlyPendingTimers());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const pressable = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.props.onPress === "function")[0]!;
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};

const tray = () =>
  renderSurface(
    <DesignProvider design="material">
      <SearchTray />
    </DesignProvider>,
  );

onAndroid("search in the material design is a full-screen Material search view: surfaceContainerHigh, a 72 dp header with a back arrow and Incognito as 48 dp icon buttons, a divider, and the suggestions as list rows", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  expect(flat(node(root, "materialSearchView")).backgroundColor).toBe(LIGHT.surfaceContainerHigh);
  expect(flat(node(root, "materialSearchHeader")).height).toBe(72);
  for (const id of ["materialSearchBack", "materialSearchIncognito"]) {
    expect(flat(node(root, id))).toMatchObject({ width: 48, height: 48 });
    expect(pressable(root, id).props.android_ripple).toMatchObject({ borderless: true });
  }
  act(() => typeSearch("site"));
  act(() => jest.advanceTimersByTime(50));
  expect(textOf(root)).toContain("Site 1");
  expect(node(root, "materialSearchRows")).toBeDefined();
  unmount(root);
});

onAndroid("the back arrow closes search, and the view leaves on Material's fade-through before it unmounts", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  act(() => pressable(root, "materialSearchBack").props.onPress());
  expect(searchState().open).toBe(false);
  act(() => jest.advanceTimersByTime(1000));
  expect(node(root, "materialSearchView")).toBeUndefined();
  unmount(root);
});

onAndroid("in Incognito the view takes the scheme's inverse surface and says so when nothing is typed", () => {
  act(() => useTabs.setState({ incognito: true }));
  act(() => presentSearch("start", ""));
  const root = tray();
  expect(flat(node(root, "materialSearchView")).backgroundColor).toBe(LIGHT.inverseSurface);
  expect(node(root, "materialSearchIncognitoNote")).toBeDefined();
  expect(root.root.findAll((found) => found.type === Text).some((found) => found.props.children === "You’re browsing Incognito")).toBe(true);
  expect(pressable(root, "materialSearchIncognito").props.accessibilityState).toEqual({ selected: true });
  unmount(root);
  act(() => useTabs.setState({ incognito: false }));
});

onAndroid("a wallpaper scheme change re-themes the open search view", () => {
  act(() => presentSearch("start", ""));
  const root = tray();
  act(() => setDynamicScheme({ light: SEEDED_SCHEMES.red.light, dark: SEEDED_SCHEMES.red.dark }));
  expect(flat(node(root, "materialSearchView")).backgroundColor).toBe(SEEDED_SCHEMES.red.light.surfaceContainerHigh);
  unmount(root);
});

onAndroid("with Remove animations the search view comes and goes at once; otherwise it fades through in 250 ms and out in 100 ms", () => {
  expect(materialSearchMs(true, true)).toBe(0);
  expect(materialSearchMs(false, true)).toBe(250);
  expect(materialSearchMs(false, false)).toBe(100);
});
