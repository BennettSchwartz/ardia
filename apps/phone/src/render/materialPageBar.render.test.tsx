import { Platform, StyleSheet, Text } from "react-native";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { FloatingBar } from "../components/browsing/FloatingBar";
import { BottomBar } from "../components/browsing/BottomBar";
import { tabCountLabel } from "../components/browsing/MaterialPageBar";
import { barCenterFromBottom, barHeight, DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as browse from "../state/browse/store";
import * as pageActions from "../state/page/actions";
import { usePageUi } from "../state/page/store";
import { usePages } from "../state/pages/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import { launchTabs } from "../state/tabs/tabsState";
import { renderSurface, someTabs, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  setDynamicScheme(null);
  usePages.setState({ navigation: {}, tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false });
  browse.useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  setDynamicScheme(null);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const pressable = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.props.onPress === "function")[0]!;
const flat = (found: ReactTestInstance | undefined) => StyleSheet.flatten(found?.props.style) ?? {};

const screen = () => {
  const tab = currentTabs().open[0]!;
  return renderSurface(
    <DesignProvider design="material">
      <BrowsingScreen tab={tab} />
    </DesignProvider>,
    { flushTimers: false },
  );
};

onAndroid("the material page bar is a Material bottom app bar: 80 dp on surfaceContainer above the navigation inset, an address search field and icon buttons, and neither the classic nor the floating bar", () => {
  const root = screen();
  expect(root.root.findAll((found) => found.type === FloatingBar)).toHaveLength(0);
  expect(root.root.findAll((found) => found.type === BottomBar)).toHaveLength(0);
  expect(flat(node(root, "materialBarBand")).backgroundColor).toBe(LIGHT.surfaceContainer);
  expect(flat(node(root, "materialPageBar")).height).toBe(80);
  expect(flat(node(root, "materialAddressField"))).toMatchObject({ height: 56, borderRadius: 9999, backgroundColor: LIGHT.surfaceContainerHigh });
  for (const id of ["materialBarPlus", "materialBarTabs", "materialBarMore"]) {
    expect(flat(node(root, id))).toMatchObject({ width: 48, height: 48 });
    expect(pressable(root, id).props.android_ripple).toMatchObject({ borderless: true });
  }
  expect(pressable(root, "materialAddressField").props.android_ripple).toMatchObject({ borderless: false });
  const order = root.root.findAll((found) => typeof found.type === "string" && ["materialBarPlus", "materialAddressField", "materialBarTabs", "materialBarMore"].includes(found.props.testID)).map((found) => found.props.testID);
  expect(order).toEqual(["materialBarPlus", "materialAddressField", "materialBarTabs", "materialBarMore"]);
  unmount(root);
});

onAndroid("the bar's height and centre are Material's 80 dp over the navigation inset", () => {
  expect(barHeight(48, "material")).toBe(128);
  expect(barCenterFromBottom(48, "material")).toBe(88);
});

onAndroid("the address field opens search with the page's address, the Tabs button the deck, + a new search and ⋯ the page menu", () => {
  const edit = jest.spyOn(pageActions, "editPageQuery").mockImplementation(() => undefined);
  const deck = jest.spyOn(browse, "showDeck").mockImplementation(() => Promise.resolve());
  const plus = jest.spyOn(browse, "newTab").mockImplementation(() => undefined);
  const menu = jest.spyOn(pageActions, "openPageMenu").mockImplementation(() => Promise.resolve());
  const root = screen();
  act(() => {
    pressable(root, "materialAddressField").props.onPress();
  });
  act(() => {
    pressable(root, "materialBarTabs").props.onPress();
  });
  act(() => {
    pressable(root, "materialBarPlus").props.onPress();
  });
  act(() => {
    pressable(root, "materialBarMore").props.onPress();
  });
  expect(edit).toHaveBeenCalled();
  expect(deck).toHaveBeenCalled();
  expect(plus).toHaveBeenCalled();
  expect(menu).toHaveBeenCalled();
  unmount(root);
});

onAndroid("the Tabs button shows the tab count in Material's outlined box, says it to TalkBack, and caps at 99+", () => {
  const root = screen();
  const tabs = pressable(root, "materialBarTabs");
  expect(tabs.props.accessibilityValue).toEqual({ text: "3 tabs" });
  expect(node(root, "materialTabCount")!.findAll((found) => found.type === Text)[0]!.props.children).toBe("3");
  expect(tabCountLabel(150)).toBe("99+");
  unmount(root);
});

onAndroid("an Incognito tab's address field takes the scheme's inverse surface", () => {
  useTabs.setState({ ...launchTabs(someTabs(1, true), 0), incognito: true, listing: 0 });
  const tab = [...currentTabs().privates, ...currentTabs().open].find((one) => one.isPrivate)!;
  const root = renderSurface(
    <DesignProvider design="material">
      <BrowsingScreen tab={tab} />
    </DesignProvider>,
    { flushTimers: false },
  );
  expect(flat(node(root, "materialAddressField")).backgroundColor).toBe(LIGHT.inverseSurface);
  unmount(root);
});

onAndroid("a wallpaper scheme change re-themes the bar", () => {
  const root = screen();
  act(() => setDynamicScheme({ light: { ...SEEDED_SCHEMES.blue.light }, dark: SEEDED_SCHEMES.blue.dark }));
  expect(flat(node(root, "materialBarBand")).backgroundColor).toBe(SEEDED_SCHEMES.blue.light.surfaceContainer);
  unmount(root);
});
