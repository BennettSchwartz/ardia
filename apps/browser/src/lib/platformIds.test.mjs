import assert from "node:assert/strict";
import { test } from "node:test";
const mac = await import("./platformTerms.ts");
const windows = await import("./platformTerms.windows.ts");
const macFeatures = (await import("./platformFeatures.ts")).PLATFORM_FEATURES;
const windowsFeatures = (await import("./platformFeatures.windows.ts")).PLATFORM_FEATURES;

test("the OS ids keep the Mac's macos report key and darwin os.type, and name Windows on Windows", () => {
  assert.deepEqual(mac.PLATFORM_IDS, { report: "macos", otel: "darwin" });
  assert.deepEqual(windows.PLATFORM_IDS, { report: "windows_os", otel: "windows" });
});

test("only the Mac reports memory pressure", () => {
  assert.equal(macFeatures.memoryPressure, true);
  assert.equal(windowsFeatures.memoryPressure, false);
});

test("every Settings pane's icon is one Windows can draw", async () => {
  const { PANES } = await import("../components/settings/settingsIndex.ts");
  const { vectorIcon } = await import("../../../../packages/expo-windows/src/symbol/layers.ts");
  assert.ok(PANES.length >= 7);
  assert.deepEqual(PANES.filter((pane) => !vectorIcon(pane.icon, 13, "semibold")).map((pane) => pane.icon), []);
});
