import { Platform, StyleSheet } from "react-native";
import { act } from "react-test-renderer";
import { LinkBubble } from "../components/onboarding/LinkBubble";
import { OnboardingView } from "../components/onboarding/OnboardingView";
import { AppIcon } from "../components/ui";
import { showOnboarding } from "../state/onboarding/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

beforeEach(() => {
  jest.useFakeTimers();
  withTabs(1);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

type Root = ReturnType<typeof renderSurface>;

const textOfNode = (node: Root["root"]) => textOf({ root: node } as Root);

const hostWithTestId = (root: Root, testID: string) => root.root.findAll((node) => node.props.testID === testID && typeof node.type === "string")[0]!;

test("the welcome step shows Ardia's own app icon large and upright, fixed at any text size, with no white photo frame, its own corner and the native apps' shadow", () => {
  showOnboarding();
  const root = renderSurface(<OnboardingView />);
  const frame = hostWithTestId(root, "welcomeIcon");
  const framed = StyleSheet.flatten(frame.props.style);
  const side = Platform.OS === "ios" ? 132 : 104;
  expect(framed.padding).toBeUndefined();
  expect(framed.backgroundColor).toBeUndefined();
  expect(framed.borderRadius).toBeCloseTo(side * 0.225);
  expect(framed.boxShadow).toBe("0px 12px 48px rgba(0, 0, 0, 0.18)");
  const icon = frame.findAll((node) => node.type === AppIcon)[0]!;
  expect(icon.props.side).toBe(side);
  expect(icon.props.scalesWithText).toBe(false);
  expect(StyleSheet.flatten(hostWithTestId(root, "appIcon").props.style).width).toBe(side);
  expect(frame.findAll((node) => node.props.source !== undefined && typeof node.type === "string").length).toBeGreaterThan(0);
  expect(framed.opacity).toBe(0);
  expect(framed.transform).toEqual([{ scale: 0.86 }]);
  unmount(root);
});

test("the default browser step's art ends at the 60-point app icon with its shadow, not a drawn logo", () => {
  const root = renderSurface(<LinkBubble />);
  const icon = hostWithTestId(root, "linkBubbleIcon").findAll((node) => node.type === AppIcon)[0]!;
  expect(icon.props).toMatchObject({ side: 60, shadow: true, scalesWithText: false });
  const drawn = StyleSheet.flatten(hostWithTestId(root, "appIcon").props.style);
  expect(drawn.width).toBe(60);
  expect(drawn.boxShadow).toBe("0px 4px 20px rgba(0, 0, 0, 0.12)");
  unmount(root);
});

test("the welcome step's Get Started is the primary action: 16-point smooth corners in the space's accent with white text in light, not a navy capsule, and each platform's height (SwiftUI's 63⅓, Compose's 50)", () => {
  showOnboarding();
  const root = renderSurface(<OnboardingView />);
  const button = root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "button" && textOfNode(node) === "Get Started")[0]!;
  const style = StyleSheet.flatten(button.props.style);
  expect(style.borderRadius).toBe(16);
  expect(style.backgroundColor).toBe("#B25B6B");
  expect(style.minHeight).toBeCloseTo(Platform.OS === "ios" ? 190 / 3 : 50);
  const label = button.findAll((node) => typeof node.type === "string" && node.type === "Text")[0]!;
  expect(StyleSheet.flatten(label.props.style).color).toBe("#FFFFFF");
  unmount(root);
});
