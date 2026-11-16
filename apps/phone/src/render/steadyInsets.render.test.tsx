import { Platform } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets, type EdgeInsets } from "react-native-safe-area-context";
import { act } from "react-test-renderer";
import { INSET_DROP_HOLD_MS, SteadyInsets } from "../components/ui";
import { renderSurface, unmount, updateSurface } from "../../test/render/harness";

const onAndroid = Platform.OS === "android" ? test : test.skip;
const NAV = 47.27;
const insets = (bottom: number, top = 24): EdgeInsets => ({ top, right: 0, bottom, left: 0 });

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function harness(start: EdgeInsets) {
  const seen: EdgeInsets[] = [];
  function Probe() {
    seen.push(useSafeAreaInsets());
    return null;
  }
  const tree = (live: EdgeInsets) => (
    <SafeAreaInsetsContext.Provider value={live}>
      <SteadyInsets>
        <Probe />
      </SteadyInsets>
    </SafeAreaInsetsContext.Provider>
  );
  const root = renderSurface(tree(start));
  return { seen, set: (live: EdgeInsets) => updateSurface(root, tree(live)), root };
}

onAndroid("on Android, a bottom inset that drops to 0 and comes back during a light/dark switch never reaches the layouts, so the deck, sheets and tray don't drop by the navigation bar", () => {
  const { seen, set, root } = harness(insets(NAV));
  set(insets(0));
  act(() => jest.advanceTimersByTime(300));
  set(insets(NAV));
  act(() => jest.advanceTimersByTime(INSET_DROP_HOLD_MS * 2));
  expect(seen.every((value) => value.bottom === NAV)).toBe(true);
  unmount(root);
});

onAndroid("on Android, an inset that grows is taken at once, and one that stays smaller for a second is taken then", () => {
  const { seen, set, root } = harness(insets(NAV));
  set(insets(NAV, 40));
  expect(seen.at(-1)!.top).toBe(40);
  set(insets(0, 40));
  act(() => jest.advanceTimersByTime(INSET_DROP_HOLD_MS - 50));
  expect(seen.at(-1)!.bottom).toBe(NAV);
  act(() => jest.advanceTimersByTime(100));
  expect(seen.at(-1)!.bottom).toBe(0);
  unmount(root);
});

test("on iPhone the insets pass straight through", () => {
  if (Platform.OS !== "ios") return;
  const { seen, set, root } = harness(insets(34));
  set(insets(0));
  expect(seen.at(-1)!.bottom).toBe(0);
  unmount(root);
});
