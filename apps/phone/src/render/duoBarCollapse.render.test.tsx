import { Dimensions, StyleSheet } from "react-native";
import { getAnimatedStyle } from "react-native-reanimated";
import { act, type ReactTestInstance } from "react-test-renderer";
import { BrowsingScreen } from "../components/browsing/BrowsingScreen";
import { DesignProvider } from "../components/ui";
import { setRootSize } from "../state/app/rootSize";
import { useScreenLayout, type ScreenHinge } from "../state/app/screenLayout";
import { useBrowse } from "../state/browse/store";
import { usePageUi } from "../state/page/store";
import { storeNavigation, usePages, type PageState } from "../state/pages/store";
import { setPreference } from "../state/settings/store";
import { currentTabs, useTabs } from "../state/tabs/store";
import type { BrowserTab } from "../state/tabs/tabModels";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const safeArea = require("react-native-safe-area-context") as { useSafeAreaInsets: () => { top: number; bottom: number; left: number; right: number } };

const PORTRAIT = Dimensions.get("window");

const POSES = [
  { name: "closed", width: 466, height: 678, hinge: "closed", stripX: 418, controlsLeft: 0, squeeze: { marginLeft: 370, marginRight: -72 } },
  { name: "open", width: 951, height: 669, hinge: "fullyOpen", stripX: 903, controlsLeft: 431, squeeze: { marginLeft: 424, marginRight: -72 } },
] as const satisfies readonly { name: string; width: number; height: number; hinge: ScreenHinge; stripX: number; controlsLeft: number; squeeze: { marginLeft: number; marginRight: number } }[];

type Pose = (typeof POSES)[number];

function onDuo(pose: Pose) {
  Dimensions.set({ window: { ...PORTRAIT, width: pose.width, height: pose.height }, screen: { ...PORTRAIT, width: pose.width, height: pose.height } });
  act(() => setRootSize(pose.width, pose.height));
  jest.spyOn(safeArea, "useSafeAreaInsets").mockImplementation(() => ({ top: 0, bottom: 34, left: 0, right: 84 }));
  act(() => useScreenLayout.setState({ hinge: pose.hinge }));
}

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(3);
  usePages.setState({ tones: {}, lastTones: {}, heldTones: {} });
  usePageUi.setState({ findOpen: false, menuOpen: false });
  useBrowse.setState({ surface: "browsing", sheet: null, deckEntrance: null, frozenOrder: null, opening: null });
  setPreference("collapsesBottomBar", true);
});

afterEach(() => {
  act(() => usePageUi.setState({ findOpen: false, menuOpen: false }));
  act(() => jest.runOnlyPendingTimers());
  act(() => setRootSize(0, 0));
  act(() => useScreenLayout.setState({ hinge: "none" }));
  Dimensions.set({ window: PORTRAIT, screen: PORTRAIT });
  jest.useRealTimers();
  jest.restoreAllMocks();
  setPreference("collapsesBottomBar", false);
});

type Root = ReturnType<typeof renderSurface>;

const scrolled = (tab: BrowserTab, scrollDirection: "up" | "down") =>
  act(() => storeNavigation(tab.id, { url: tab.url, title: "Site", isLive: true, isLoading: false, progress: 1, failure: null, canGoBack: false, canGoForward: false, scrollDirection } as unknown as PageState));

const page = (tab: BrowserTab) => {
  scrolled(tab, "up");
  return renderSurface(
    <DesignProvider design="redesigned">
      <BrowsingScreen tab={tab} />
    </DesignProvider>,
  );
};

const settle = () => {
  for (let frame = 0; frame < 90; frame++) act(() => jest.advanceTimersByTime(16));
};

const host = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0];
const animatedOf = (node: ReactTestInstance) => (node.props.style ? getAnimatedStyle(node) : {});
const shown = (node: ReactTestInstance) => ({ ...StyleSheet.flatten(node.props.style), ...animatedOf(node) }) as { opacity?: number; marginLeft?: number; marginRight?: number; left?: number; top?: number; transform?: Record<string, number>[] };
const lifted = (node: ReactTestInstance) => (Object.assign({}, ...(shown(node).transform ?? [])) as { translateY?: number }).translateY ?? 0;
const glyphOf = (node: ReactTestInstance) => {
  let glyph: ReactTestInstance | null = node.parent;
  while (glyph && typeof glyph.type !== "string") glyph = glyph.parent;
  return glyph!;
};
const pageMenu = (root: Root) => root.root.findAll((node) => typeof node.props.accessibilityLabel === "string" && node.props.accessibilityLabel.startsWith("Page Menu") && typeof node.props.onPress === "function")[0]!;

for (const pose of POSES) {
  test(`on the ${pose.name} Duo, scrolling down squeezes the capsule into a 48 ··· circle on the bar's line in the strip at ${pose.stripX}, Tabs and + rise a step, and no host pill shows`, () => {
    onDuo(pose);
    const tab = currentTabs().open[0]!;
    const root = page(tab);
    expect(Math.abs(shown(host(root, "floatingBarCentre")!).marginLeft ?? 0)).toBe(0);
    expect(Math.abs(shown(host(root, "floatingBarCentre")!).marginRight ?? 0)).toBe(0);
    expect(lifted(host(root, "floatingBarStrip")!)).toBeCloseTo(0, 3);
    expect(pageMenu(root).props.accessibilityLabel).toBe("Page Menu");
    scrolled(tab, "down");
    settle();
    expect(host(root, "hostPill")).toBeUndefined();
    expect(host(root, "hostPillFold")).toBeUndefined();
    const centre = shown(host(root, "floatingBarCentre")!);
    expect(centre.marginLeft).toBeCloseTo(pose.squeeze.marginLeft, 3);
    expect(centre.marginRight).toBeCloseTo(pose.squeeze.marginRight, 3);
    expect(pose.controlsLeft + 24 + pose.squeeze.marginLeft).toBe(pose.stripX - 24);
    expect(shown(host(root, "floatingBarAddressFade")!).opacity).toBeCloseTo(0, 3);
    expect(host(root, "floatingBarAddressFade")!.props.accessibilityElementsHidden).toBe(true);
    expect(lifted(host(root, "floatingBarStrip")!)).toBeCloseTo(-55, 3);
    expect(host(root, "floatingBarFold")!.props.pointerEvents).toBe("box-none");
    expect(StyleSheet.flatten(host(root, "floatingBarFold")!.props.style)?.opacity).toBeUndefined();
    expect(pageMenu(root).props.accessibilityLabel).toMatch(/^Page Menu, \S/);
    unmount(root);
  });
}

test("collapsed on the Duo, the ··· circle opens the page menu and leaves the bar collapsed, and its label carries the site", async () => {
  onDuo(POSES[0]);
  const tab = { ...currentTabs().open[0]!, url: "https://www.swift.org/" };
  useTabs.setState((state) => ({ open: state.open.map((t) => (t.id === tab.id ? tab : t)) }));
  const root = page(tab);
  scrolled(tab, "down");
  settle();
  const more = pageMenu(root);
  expect(more.props.accessibilityLabel).toBe("Page Menu, swift.org");
  await act(async () => {
    more.props.onPress();
  });
  expect(usePageUi.getState().menuOpen).toBe(true);
  settle();
  expect(shown(host(root, "floatingBarCentre")!).marginLeft).toBeCloseTo(370, 3);
  unmount(root);
});

test("collapsed on the Duo, an insecure page shows the red open lock in the circle in place of the dots, and says Not Secure", () => {
  onDuo(POSES[0]);
  const tab = { ...currentTabs().open[0]!, url: "http://plain.example/" };
  useTabs.setState((state) => ({ open: state.open.map((t) => (t.id === tab.id ? tab : t)) }));
  const root = page(tab);
  expect(shown(glyphOf(host(root, "floatingBarMoreNotSecure")!)).opacity).toBeCloseTo(0, 3);
  scrolled(tab, "down");
  settle();
  expect(shown(glyphOf(host(root, "floatingBarMoreNotSecure")!)).opacity).toBeCloseTo(1, 3);
  expect(pageMenu(root).props.accessibilityLabel).toBe("Page Menu, Not Secure, plain.example");
  unmount(root);
});

test("with no hinge, scrolling down still folds the bar into the host pill", () => {
  const tab = currentTabs().open[0]!;
  const root = page(tab);
  scrolled(tab, "down");
  settle();
  expect(host(root, "hostPill")).toBeDefined();
  expect(host(root, "floatingBarStrip")).toBeUndefined();
  expect(host(root, "floatingBarFold")!.props.pointerEvents).toBe("none");
  expect(pageMenu(root).props.accessibilityLabel).toBe("Page Menu");
  unmount(root);
});
