import { Platform, Pressable } from "react-native";
import { act } from "react-test-renderer";
import { DesignProvider } from "../components/ui";
import { confirmInSheet, MenuTrigger } from "../components/ui/MenuTrigger";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { setDynamicScheme } from "../state/app/dynamicScheme";
import { setAppearanceDesign, useAppearanceDesign } from "../state/settings/appearance";
import { currentPreferences, setPreference } from "../state/settings/store";
import { renderSurface, unmount, withMaterialYou } from "../../test/render/harness";
import { mockNative, resetNativeMenus } from "./nativeMenusMock";

withMaterialYou();

jest.mock("@ardia/phone-native", () => require("./nativeMenusMock").nativeMenusModule(jest.requireActual("@ardia/phone-native")));

const onAndroid = Platform.OS === "android" ? test : test.skip;
let colorWas: ReturnType<typeof currentPreferences>["colorChoice"];
let schemeWas: ReturnType<typeof currentPreferences>["schemeChoice"];
let designWas: ReturnType<typeof useAppearanceDesign.getState>["design"];

beforeEach(() => {
  jest.useFakeTimers();
  resetNativeMenus(true);
  colorWas = currentPreferences().colorChoice;
  schemeWas = currentPreferences().schemeChoice;
  designWas = useAppearanceDesign.getState().design;
  setPreference("schemeChoice", "light");
  setDynamicScheme({ light: SEEDED_SCHEMES.red.light, dark: SEEDED_SCHEMES.red.dark });
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  setPreference("colorChoice", colorWas);
  setPreference("schemeChoice", schemeWas);
  setDynamicScheme(null);
  setAppearanceDesign(designWas);
  resetNativeMenus();
  jest.useRealTimers();
});

const menuAppearance = (dark?: boolean) => {
  const root = renderSurface(
    <DesignProvider design="material">
      <MenuTrigger items={[{ label: "Copy Link", onPress: () => undefined }]} trigger="tap" dark={dark}>
        {({ onPress }) => <Pressable onPress={onPress} />}
      </MenuTrigger>
    </DesignProvider>,
  );
  const appearance = root.root.findAll((found) => found.type === ("ContextMenuView" as never))[0]!.props.appearance;
  unmount(root);
  return appearance;
};

onAndroid("native menus get the wallpaper scheme when no profile colour is picked, and the picked colour's scheme when one is, so they match the JS surfaces", () => {
  setPreference("colorChoice", null);
  expect(menuAppearance().scheme).toEqual(SEEDED_SCHEMES.red.light);
  setPreference("colorChoice", "pink");
  expect(menuAppearance().scheme).toEqual(SEEDED_SCHEMES.pink.light);
});

onAndroid("a menu forced dark, as Incognito's are, gets the dark side of the same scheme", () => {
  setPreference("colorChoice", "pink");
  expect(menuAppearance(true)).toEqual({ dark: true, scheme: SEEDED_SCHEMES.pink.dark });
});

onAndroid("a native confirm dialog in the material design carries the same scheme", () => {
  setPreference("colorChoice", "blue");
  setAppearanceDesign("material");
  confirmInSheet({ title: "Close All Tabs?", message: "They stay in your Archive.", action: "Close All", run: () => undefined }, () => undefined);
  expect((mockNative.sheets[0] as { appearance: { scheme: unknown } }).appearance.scheme).toEqual(SEEDED_SCHEMES.blue.light);
});
