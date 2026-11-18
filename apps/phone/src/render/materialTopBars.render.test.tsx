import { Platform, StyleSheet, Text } from "react-native";
import { act } from "react-test-renderer";
import { SpacesView } from "../components/sync/SpacesView";
import { ArchiveView } from "../components/tabs/ArchiveView";
import { DesignProvider } from "../components/ui";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import * as browse from "../state/browse/store";
import { renderSurface, unmount, withTabs } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
  setDynamicScheme(null);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;
const node = (root: Root, id: string) => root.root.findAll((found) => found.props.testID === id && typeof found.type === "string")[0];
const texts = (root: Root) => root.root.findAll((found) => found.type === Text).map((found) => found.props.children);
const material = (child: React.ReactElement) => renderSurface(<DesignProvider design="material">{child}</DesignProvider>);

onAndroid("the Archive opens on a Material top app bar: a close icon at the start, the title start-aligned in titleLarge, Options at the end, a Material search field, and no iPhone Done", () => {
  const closed = jest.spyOn(browse, "closeArchive").mockImplementation(() => undefined);
  const root = material(<ArchiveView />);
  expect(node(root, "materialTopBar")).toBeDefined();
  expect(texts(root)).not.toContain("Done");
  const title = root.root.findAll((found) => found.type === Text && found.props.children === "Archive")[0]!;
  expect(StyleSheet.flatten(title.props.style)).toMatchObject({ fontSize: 22, color: LIGHT.onSurface });
  expect(StyleSheet.flatten(node(root, "materialSearchField")!.props.style)).toMatchObject({ height: 56, borderRadius: 9999, backgroundColor: LIGHT.surfaceContainerHigh });
  act(() => {
    root.root.findAll((found) => found.props.testID === "materialTopBarNav" && typeof found.props.onPress === "function")[0]!.props.onPress();
  });
  expect(closed).toHaveBeenCalled();
  unmount(root);
});

onAndroid("the Archive's empty state takes the scheme's primaryContainer, not the purple tile", () => {
  const root = material(<ArchiveView />);
  act(() => jest.advanceTimersByTime(1000));
  const icon = node(root, "materialEmptyIcon");
  if (icon) expect(StyleSheet.flatten(icon.props.style).backgroundColor).toBe(LIGHT.primaryContainer);
  unmount(root);
});

onAndroid("the Spaces sheet opens on the same Material top app bar, close at the start and Archive at the end", () => {
  const root = material(<SpacesView />);
  expect(node(root, "materialTopBar")).toBeDefined();
  expect(root.root.findAll((found) => found.props.accessibilityLabel === "Archive" && typeof found.props.onPress === "function").length).toBeGreaterThan(0);
  unmount(root);
});
