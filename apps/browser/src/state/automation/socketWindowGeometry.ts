import type { JsonSchema } from "../../lib/jsonSchema";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { setWindowFrame, setWindowFullScreen, setWindowZoomed, windowGeometry, type WindowGeometry } from "../../platform/windows";
import { useBrowser } from "../browser/store";
import type { MethodSpec } from "./socketCatalog";
import { bool, obj, WINDOW } from "./socketSchema";
import { expect, now, windowOf } from "./socketTargets";
import { windowRow } from "./socketWindows";
import { OpError } from "./workspaceTargets";

const FULL_SCREEN_WAIT_MS = 4000;

function geometryWindow(id: unknown, kinds: Parameters<typeof windowOf>[1] = ["normal", "little"]) {
  if (!PLATFORM_FEATURES.windowGeometry) throw new OpError("refused", "Ardia can't move or resize its windows from the ardia command on this platform yet.");
  return windowOf(id, kinds);
}

async function nativeGeometry(id: string, change: Promise<WindowGeometry | null>) {
  const geometry = await change;
  if (!geometry) throw new OpError("no_window", `Window ${id} isn't on screen.`);
  return geometry;
}

const answer = (id: string, geometry: WindowGeometry) => ({ ...windowRow(now(), id), frame: geometry.frame, maximized: geometry.zoomed, fullScreen: geometry.fullScreen, geometry });

function isFullScreen(id: string) {
  return !!now().windows[id]?.fullScreen;
}

async function setFrame(params: Record<string, unknown>) {
  const w = geometryWindow(params.window);
  if (isFullScreen(w.id)) throw new OpError("refused", `Window ${w.id} is full screen; leave full screen first (windows.setFullScreen).`);
  const frame = params.frame as [number, number, number, number];
  const geometry = await nativeGeometry(w.id, setWindowFrame(w.id, frame));
  expect(!geometry.fullScreen, "the window is full screen.");
  return answer(w.id, geometry);
}

async function setMaximized(params: Record<string, unknown>) {
  const w = geometryWindow(params.window);
  if (isFullScreen(w.id)) throw new OpError("refused", `Window ${w.id} is full screen; leave full screen first (windows.setFullScreen).`);
  const geometry = await nativeGeometry(w.id, setWindowZoomed(w.id, params.on as boolean));
  expect(geometry.zoomed === params.on, `the window isn't ${params.on ? "zoomed" : "back from zoom"}.`);
  return answer(w.id, geometry);
}

function storeFullScreen(id: string, on: boolean): Promise<boolean> {
  if (isFullScreen(id) === on) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), FULL_SCREEN_WAIT_MS);
    const stop = useBrowser.subscribe((s) => {
      if (!s.windows[id]) finish(false);
      else if (!!s.windows[id]!.fullScreen === on) finish(true);
    });
    function finish(ok: boolean) {
      clearTimeout(timer);
      stop();
      resolve(ok);
    }
  });
}

async function setFullScreen(params: Record<string, unknown>) {
  const w = geometryWindow(params.window, ["normal"]);
  const on = params.on as boolean;
  const before = await nativeGeometry(w.id, windowGeometry(w.id));
  if (!before.visible || before.miniaturized) throw new OpError("refused", `Window ${w.id} is hidden or in the Dock; show it first (windows.focus).`);
  await nativeGeometry(w.id, setWindowFullScreen(w.id, on));
  expect(await storeFullScreen(w.id, on), `the window didn't ${on ? "enter" : "leave"} full screen (a page may be full screen in it).`);
  return answer(w.id, await nativeGeometry(w.id, windowGeometry(w.id)));
}

const FRAME: JsonSchema = {
  type: "array",
  description: "[x, y, width, height] in screen points, from the bottom-left of the main display, as windows reports it",
  prefixItems: [{ type: "number" }, { type: "number" }, { type: "number", minimum: 1 }, { type: "number", minimum: 1 }],
  minItems: 4,
  maxItems: 4,
};

export const WINDOW_GEOMETRY_METHODS: MethodSpec[] = [
  {
    name: "windows.geometry",
    mutates: false,
    description: "Where a window is on screen: its frame, whether it's zoomed, full screen or in the Dock, and its display",
    params: obj({ window: WINDOW }, ["window"]),
    result: "{frame, zoomed, fullScreen, miniaturized, visible, display}",
    run: async (p) => nativeGeometry(String(p.window), windowGeometry(geometryWindow(p.window).id)),
  },
  { name: "windows.setFrame", mutates: true, description: "Move and resize a window; it stays on a display and at least its smallest size", params: obj({ window: WINDOW, frame: FRAME }, ["window", "frame"]), result: "window", run: setFrame },
  { name: "windows.setMaximized", mutates: true, description: "Zoom a window to fill its display, as double-clicking its title bar does, or put it back", params: obj({ window: WINDOW, on: bool("Zoomed or not") }, ["window", "on"]), result: "window", run: setMaximized },
  { name: "windows.setFullScreen", mutates: true, description: "Put a window in full screen in its own Space, or bring it back; answers once it has", params: obj({ window: WINDOW, on: bool("Full screen or not") }, ["window", "on"]), result: "window", run: setFullScreen },
];
