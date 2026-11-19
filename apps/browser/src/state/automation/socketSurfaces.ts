import { dismissSurface, menuBar, onSurface, openSurfaces, performMenuBarItem, type OpenSurface, type SurfaceEvent, type SurfaceItem } from "../../platform/surfaces";
import type { BrowserState } from "../browser/store";
import { eligibleKind, isEligibleTab, lastFocusedEligibleWindow } from "./automationWindows";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { id, obj, text } from "./socketSchema";
import { now } from "./socketTargets";
import type { EventSend } from "./storeEvents";
import { OpError } from "./workspaceTargets";
import { runMethod } from "./controlSocket";
import { backgroundInstance } from "../app/appSettings";

const PAGE_KINDS: ReadonlySet<string> = new Set(["select", "page"]);
export const CAPTURED_PICK_NEEDS_ENGINE =
  "A captured page menu is listed only: picking from it waits for engine support that runs the item for the frame the menu came from (runContextMenuCommand in ac_context_menu.mm).";
export const PRIVATE_WINDOW_OPEN = "A private window is open, so the ardia command doesn't use the menu bar until it closes.";
export const PAGE_PICK_REFUSED =
  "Picking from a page's menu or <select> popup is refused: its items run page and app actions (Share among them) outside run's policy. Run a menu bar item from menus.bar with menus.runBar instead.";
export const LIVE_PAGE_MENU_REFUSED =
  "A page's context menu on screen isn't used: nothing in the menu says which tab and window it came from, so the ardia command can't tell whose it is.";
export const TRACKED_BAR_REFUSED = "The ardia command doesn't use the menu bar while it tracks; run an item from menus.bar with menus.runBar instead.";
export const NATIVE_ITEMS_NEED_VISIBLE = "A background Ardia runs no native menu item (Minimize, Zoom and the like), and run refuses every command there, so menus.runBar runs nothing in it.";
export const DYNAMIC_ROW_REFUSED = "That row stands for a menu built from open windows, profiles, pages or history, which the ardia command doesn't read or run.";

const privateOpen = (s: BrowserState) => Object.values(s.windows).some((w) => w.kind === "private");

export const surfaceRunMode = { background: backgroundInstance };

function refusePrivate(call?: SocketCall) {
  call?.stillServing();
  if (privateOpen(now())) throw new OpError("refused", PRIVATE_WINDOW_OPEN);
}

function catalogItem(items: SurfaceItem[], ref: string): SurfaceItem | undefined {
  for (const item of items) {
    if (item.ref === ref) return item;
    const below = item.submenu && catalogItem(item.submenu, ref);
    if (below) return below;
  }
  return undefined;
}

export function visibleSurface(s: BrowserState, surface: OpenSurface): (Omit<OpenSurface, "window" | "tab"> & { window: string; tab: string | null }) | null {
  if (surface.kind === "menuBar" || (surface.kind === "page" && !surface.captured)) return null;
  const window = surface.window;
  if (!window || !eligibleKind(s, window)) return null;
  if (surface.tab) {
    if (!isEligibleTab(s, surface.tab) || s.tabs[surface.tab]?.windowId !== window) return null;
  } else if (PAGE_KINDS.has(surface.kind)) return null;
  return { ...surface, window, tab: surface.tab ?? null };
}

async function nativeCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    const message = error instanceof Error ? error.message : String(error);
    if (code.includes("no_window")) throw new OpError("no_window", message);
    if (code.includes("refused")) throw new OpError("refused", message);
    throw error;
  }
}

async function surfaceOf(menuId: string) {
  const raw = (await openSurfaces()).find((m) => m.id === menuId);
  if (raw?.kind === "menuBar") throw new OpError("refused", TRACKED_BAR_REFUSED);
  if (raw?.kind === "page" && !raw.captured) throw new OpError("refused", LIVE_PAGE_MENU_REFUSED);
  const found = raw && visibleSurface(now(), raw);
  if (!found) throw new OpError("no_window", `There's no open menu ${menuId}; menus.open lists them.`);
  return found;
}

async function choose(params: Record<string, unknown>) {
  const surface = await surfaceOf(params.menu as string);
  if (surface.captured) throw new OpError("refused", CAPTURED_PICK_NEEDS_ENGINE);
  if (PAGE_KINDS.has(surface.kind)) throw new OpError("refused", PAGE_PICK_REFUSED);
  throw new OpError("refused", "Ardia's own menus stay with you; run a menu bar item from menus.bar with menus.runBar instead.");
}

async function dismiss(params: Record<string, unknown>, call: SocketCall) {
  const surface = await surfaceOf(params.menu as string);
  call.stillServing();
  await nativeCall(() => dismissSurface(surface.id));
  return { ok: true };
}

async function runBarItem(params: Record<string, unknown>, call: SocketCall) {
  const path = params.path as number[];
  const ref = params.ref as string;
  const window = (params.window as string | undefined) ?? null;
  refusePrivate(call);
  const item = catalogItem(await nativeCall(() => menuBar()), ref);
  if (!item || item.path.join() !== path.join()) throw new OpError("no_window", "There's no menu bar item with that path and ref; menus.bar lists them.");
  if (item.dynamic) throw new OpError("refused", DYNAMIC_ROW_REFUSED);
  if (item.separator || item.submenu) throw new OpError("no_window", `${item.title || "That row"} isn't an item that runs.`);
  if (typeof item.command === "string") {
    refusePrivate(call);
    const ran = runMethod({ command: item.command, arg: item.arg ?? null, window, tab: null }, surfaceRunMode.background);
    if ("error" in ran) {
      const { code, message } = ran.error as { code: OpError["code"]; message: string };
      throw new OpError(code, message);
    }
    return { ok: true, title: item.title, command: item.command };
  }
  if (surfaceRunMode.background) throw new OpError("refused", NATIVE_ITEMS_NEED_VISIBLE);
  const s = now();
  if (window !== null && !eligibleKind(s, window)) throw new OpError("refused", "That window isn't one the ardia command may use.");
  const target = window ?? lastFocusedEligibleWindow(s);
  if (!target) throw new OpError("no_window", "No window the ardia command may use is focused.");
  refusePrivate(call);
  const title = await nativeCall(() => performMenuBarItem(ref, target));
  return { ok: true, title, action: item.action ?? null };
}

const MENU = id("A menu id from menus.open");
const PATH = { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: 8, description: "The item's path, as menus.bar gives it" } as const;
const REF = text("The item's ref, as menus.bar gives it: its command or action and its static titles");

export const SURFACE_METHODS: MethodSpec[] = [
  {
    name: "menus.open",
    mutates: false,
    description: "Menus open now (a page's <select> popup, a page's context menu captured in a hidden Ardia, an Ardia menu) with their items and their enabled and checked state; never the menu bar or a context menu on screen, whose source isn't known",
    params: obj({}),
    result: "[{id, kind, window, tab, items}]",
    run: async () => {
      const s = now();
      return (await openSurfaces()).flatMap((m) => visibleSurface(s, m) ?? []);
    },
  },
  {
    name: "menus.choose",
    mutates: true,
    hidden: true,
    description: "Refused for every open menu: picks from a page's menu, a <select> popup, a captured page menu, Ardia's own menus or a tracking menu bar don't run; run a menu bar item from menus.bar with menus.runBar instead",
    params: obj({ menu: MENU, path: PATH, ref: REF }, ["menu", "path"]),
    result: "{ok, menu, kind, title}",
    run: choose,
  },
  {
    name: "menus.dismiss",
    mutates: true,
    description: "Close an open page or Ardia menu without choosing, as Escape or a click away does",
    params: obj({ menu: MENU }, ["menu"]),
    result: "{ok}",
    run: dismiss,
  },
  {
    name: "menus.bar",
    mutates: false,
    description:
      "A static catalog of the menu bar, built from its definition: every menu and item with its path, ref, title, shortcut, and its command when run takes it, or its action. Menus built from open windows, profiles, pages or history are one dynamic row each. Refused while any private window is open",
    params: obj({}),
    result: "[{path, ref, title, separator, key?, command?, arg?, action?, dynamic?, submenu?}]",
    run: async () => {
      refusePrivate();
      return nativeCall(() => menuBar());
    },
  },
  {
    name: "menus.runBar",
    mutates: true,
    description:
      "Run a menu bar item from menus.bar: an Ardia command goes through run and its policy (refused when it needs the person, such as Open File or Print); a window item (Minimize, Zoom, Enter Full Screen, Minimize All, Arrange in Front) goes to the named key window or the app, with no menu validation. In a background Ardia it runs nothing: run refuses every command there, and native items need a visible Ardia. Also refused while any private window is open, for dynamic rows, and for Quit, Hide, Close Window, updates and items that only act through the responder chain",
    params: obj({ path: PATH, ref: REF, window: text("The window to run it in; the last focused one when left out. Window items act only when it is the key window and the item can be sent to that window itself") }, ["path", "ref"]),
    result: "{ok, title, command? | action?}",
    run: runBarItem,
  },
];

const EVENT_OF: Partial<Record<SurfaceEvent["type"], "menu.opened" | "menu.closed">> = { menuOpened: "menu.opened", menuClosed: "menu.closed" };

export function startSurfaceEvents(send: EventSend, wants: ReadonlySet<string>) {
  const shown = new Set<string>();
  const sub = onSurface((event) => {
    if (event.type === "menuDropped") {
      shown.delete(event.id);
      return;
    }
    const name = EVENT_OF[event.type];
    if (!name) return;
    if (event.type === "menuOpened") {
      const visible = visibleSurface(now(), event);
      if (!visible) return;
      shown.add(event.id);
      if (wants.has(name)) send(name, { id: visible.id, kind: visible.kind, windowId: visible.window, tabId: visible.tab, items: visible.items?.length ?? 0 });
    } else if (shown.delete(event.id) && wants.has(name)) {
      send(name, { id: event.id, kind: event.kind });
    }
  });
  return () => sub.remove();
}
