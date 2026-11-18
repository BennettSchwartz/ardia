import { Platform } from "react-native";
import type { ReactElement } from "react";
import { ContextMenuView } from "@ardia/phone-native";

jest.mock("expo-modules-core", () => {
  const actual = jest.requireActual("expo-modules-core");
  return {
    ...actual,
    requireOptionalNativeModule: (name: string) => name === "ArdiaPhoneMenus" ? { hasContextMenu: true } : actual.requireOptionalNativeModule(name),
    requireNativeViewManager: (name: string) => name === "ArdiaPhoneMenus" ? "NativeMenu" : actual.requireNativeViewManager(name),
  };
});

test("native menu actions reach JavaScript without registering Android's built-in selection event", () => {
  const selected = jest.fn();
  const menu = ContextMenuView({ items: [{ id: "settings", title: "Settings" }], onSelect: selected }) as ReactElement<Record<string, (event: unknown) => void>>;
  const event = Platform.OS === "android" ? "onMenuSelect" : "onSelect";
  if (Platform.OS === "android") expect(menu.props.onSelect).toBeUndefined();
  menu.props[event]!({ nativeEvent: { id: "settings" } });
  expect(selected).toHaveBeenCalledWith("settings");
});
