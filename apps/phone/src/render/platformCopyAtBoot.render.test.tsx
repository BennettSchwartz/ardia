import { Platform } from "react-native";
import { act } from "react-test-renderer";
import { copy, copyTable } from "../lib/platformCopy";
import { bootApp } from "../state/app/boot";

jest.mock("../state/legacy/upgrade", () => ({
  importOldApp: () => new Promise(() => undefined),
  startWithoutOldApp: async () => false,
  offersStartWithout: () => true,
}));

test("booting picks this platform's words, so they don't hang on which module happens to load first", () => {
  const platform = Platform.OS === "ios" ? "ios" : "android";
  act(() => bootApp(() => undefined));
  expect(copy().thisDevice).toBe(copyTable(platform).thisDevice);
  expect(copy().readerSerif).toEqual(copyTable(platform).readerSerif);
  expect(copy().defaultBrowserInstructions).toEqual(copyTable(platform).defaultBrowserInstructions);
});
