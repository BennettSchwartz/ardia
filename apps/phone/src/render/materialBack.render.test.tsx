import { predictiveBack, type PredictiveBackHandlers } from "@ardia/phone-native";
import { Platform, Text } from "react-native";
import { act } from "react-test-renderer";
import { Dialog, DesignProvider, Menu, Sheet } from "../components/ui";
import { materialSheetBackOffset } from "../components/ui/MaterialSurfaces";
import { renderSurface, unmount } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const claims: PredictiveBackHandlers[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  claims.length = 0;
  jest.spyOn(predictiveBack, "isNative").mockImplementation(() => true);
  jest.spyOn(predictiveBack, "claim").mockImplementation((handlers) => {
    claims.push(handlers);
    return { remove: () => void claims.splice(claims.indexOf(handlers), 1) };
  });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const material = (node: React.ReactNode) => renderSurface(<DesignProvider design="material">{node}</DesignProvider>);
const top = () => claims[claims.length - 1]!;

onAndroid("an open Material sheet claims predictive back: it follows the swipe down by up to 72 dp, and a committed swipe dismisses it", () => {
  const dismissed = jest.fn();
  const root = material(
    <Sheet open onDismiss={dismissed} onHidden={() => undefined}>
      <Text>Rows</Text>
    </Sheet>,
  );
  expect(claims).toHaveLength(1);
  expect(materialSheetBackOffset(0.5)).toBe(36);
  expect(materialSheetBackOffset(2)).toBe(72);
  act(() => top().onProgress?.(0.5, "left"));
  act(() => top().onCancel?.());
  expect(dismissed).not.toHaveBeenCalled();
  act(() => top().onCommit?.());
  expect(dismissed).toHaveBeenCalledTimes(1);
  unmount(root);
  expect(claims).toHaveLength(0);
});

onAndroid("a Material dialog or menu opened over a sheet takes Back from it, and gives it back when it closes", () => {
  const sheet = jest.fn();
  const dialog = jest.fn();
  const menu = jest.fn();
  const root = material(
    <Sheet open onDismiss={sheet} onHidden={() => undefined}>
      <Text>Rows</Text>
    </Sheet>,
  );
  const over = material(<Dialog title="Close All Tabs?" onDismiss={dialog} buttons={[{ title: "Cancel", onPress: dialog }]} />);
  act(() => top().onCommit?.());
  expect(dialog).toHaveBeenCalledTimes(1);
  unmount(over);
  const floating = material(<Menu place={{ top: 100, left: 20 }} onDismiss={menu} items={[{ label: "Copy Link", icon: "link", onPress: () => undefined }]} />);
  act(() => top().onCommit?.());
  expect(menu).toHaveBeenCalledTimes(1);
  unmount(floating);
  act(() => top().onCommit?.());
  expect(sheet).toHaveBeenCalledTimes(1);
  unmount(root);
});

onAndroid("a closed sheet holds no claim", () => {
  const root = material(
    <Sheet open={false} onDismiss={() => undefined} onHidden={() => undefined}>
      <Text>Rows</Text>
    </Sheet>,
  );
  expect(claims).toHaveLength(0);
  unmount(root);
});
