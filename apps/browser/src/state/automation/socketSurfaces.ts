import { checkMenuBarItem, dismissSurface, menuBar, onSurface, openSurfaces, performMenuBarItem, type OpenSurface, type SurfaceEvent, type SurfaceItem } from "../../platform/surfaces";
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
const APP_WIDE_ACTIONS: ReadonlySet<string> = new Set(["miniaturizeAll:", "arrangeWindowsInFront:", "arrangeInFront:"]);

const privateOpen = (s: BrowserState) => Object.values(s.windows).some((w) => w.kind === "private");

export const surfaceRunMode = { background: backgroundInstance };
export const NATIVE_ITEMS_NEED_VISIBLE = "A background Ardia runs no native menu item (Minimize, Zoom and the like): only the Ardia commands its background allowlist names.";

function structureOf(item: SurfaceItem): SurfaceItem {
  const { path, title, separator, ref, key, command, arg, action, boundWindow } = item;
  const kept: SurfaceItem = { path, title, separator, ref };
  if (key !== undefined) kept.key = key;
  if (command !== undefined) kept.command = command;
  if (arg !== undefined) kept.arg = arg;
  if (action !== undefined) kept.action = action;
  if (boundWindow !== undefined) kept.boundWindow = boundWindow;
  return kept;
}

export function shownItems(s: BrowserState, items: SurfaceItem[]): SurfaceItem[] {
  return items.flatMap((item) => {
    if (item.boundWindow !== undefined && !(item.boundWindow && eligibleKind(s, item.boundWindow))) return [];
    const kept = structureOf(item);
    return [item.submenu ? { ...kept, submenu: shownItems(s, item.submenu) } : kept];
  });
}

function itemAt(items: SurfaceItem[], path: number[]): SurfaceItem | undefined {
  for (const item of items) {
    if (item.path.length === path.length && item.path.every((step, i) => step === path[i])) return item;
    if (item.submenu && item.path.every((step, i) => step === path[i])) {
      const found = itemAt(item.submenu, path);
      if (found) return found;
    }
  }
  return undefined;
}

export const REFLECTS_PRIVATE = "A private window is open and the menu bar can reflect it, so the ardia command can't read or use the menu bar until it closes.";
export const PAGE_PICK_REFUSED =
  "Picking from a page's menu or <select> popup is refused: its items run page and app actions (Share among them) outside run's policy. The ardia command chooses only from the menu bar.";

export function visibleSurface(s: BrowserState, surface: OpenSurface): (Omit<OpenSurface, "window" | "tab"> & { window: string; tab: string | null }) | null {
  if (surface.kind === "menuBar" && (surface.reflectsPrivate || privateOpen(s))) return null;
  const window = surface.window ?? (surface.kind === "menuBar" && surface.keyless ? lastFocusedEligibleWindow(s) : null);
  if (!window || !eligibleKind(s, window)) return null;
  if (surface.tab) {
    if (!isEligibleTab(s, surface.tab) || s.tabs[surface.tab]?.windowId !== window) return null;
  } else if (PAGE_KINDS.has(surface.kind)) return null;
  return { ...surface, window, tab: surface.tab ?? null, ...(surface.items ? { items: shownItems(s, surface.items) } : {}) };
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
  const s = now();
  const raw = (await openSurfaces()).find((m) => m.id === menuId);
  if (raw?.kind === "menuBar" && (raw.reflectsPrivate || privateOpen(s))) throw new OpError("refused", REFLECTS_PRIVATE);
  const found = raw && visibleSurface(s, raw);
  if (!found) throw new OpError("no_window", `There's no open menu ${menuId}; menus.open lists them.`);
  return found;
}

async function choose(params: Record<string, unknown>, call: SocketCall) {
  const surface = await surfaceOf(params.menu as string);
  const path = params.path as number[];
  if (surface.kind === "menuBar") {
    if (privateOpen(now())) throw new OpError("refused", REFLECTS_PRIVATE);
    if (typeof params.ref !== "string") throw new OpError("bad_request", "A menu bar item is chosen by its ref as well as its path; menus.open and menus.bar give both.");
    const own = itemAt(surface.items ?? [], path);
    if (!own || own.separator || own.submenu) throw new OpError("no_window", `There's no item at that path in menu ${surface.id}; menus.open lists its items.`);
    if (own.ref !== params.ref) throw new OpError("refused", "That ref isn't the item at that path in this menu.");
    let closed = false;
    const watch = onSurface((event) => {
      if (event.type === "menuClosed" && event.id === surface.id) closed = true;
    });
    const stillOpen = async () => {
      call.stillServing();
      await surfaceOf(surface.id);
      call.stillServing();
      if (closed) throw new OpError("no_window", `Menu ${surface.id} closed.`);
    };
    const tracking = () => {
      call.stillServing();
      if (privateOpen(now())) throw new OpError("refused", REFLECTS_PRIVATE);
      if (closed) throw new OpError("no_window", `Menu ${surface.id} closed before its item could run.`);
    };
    try {
      const ran = await runBarEntry(surface.id, path, params.ref, surface.window, call, stillOpen, tracking);
      await dismissSurface(surface.id).catch(() => undefined);
      return { ok: true, menu: surface.id, kind: surface.kind, ...ran };
    } finally {
      watch.remove();
    }
  }
  if (surface.captured) throw new OpError("refused", CAPTURED_PICK_NEEDS_ENGINE);
  if (PAGE_KINDS.has(surface.kind)) throw new OpError("refused", PAGE_PICK_REFUSED);
  throw new OpError("refused", "Only the menu bar is chosen from here; Ardia's own menus stay with you.");
}

async function dismiss(params: Record<string, unknown>, call: SocketCall) {
  const surface = await surfaceOf(params.menu as string);
  call.stillServing();
  await nativeCall(() => dismissSurface(surface.id));
  return { ok: true };
}

async function runBarEntry(
  menuId: string | null,
  path: number[],
  ref: string,
  window: string | null,
  call: SocketCall,
  stillOpen: () => Promise<void> = async () => call.stillServing(),
  rightBeforeRun: () => void = () => {
    call.stillServing();
    if (privateOpen(now())) throw new OpError("refused", REFLECTS_PRIVATE);
  },
) {
  if (privateOpen(now())) throw new OpError("refused", REFLECTS_PRIVATE);
  const bar = await nativeCall(() => menuBar());
  await stillOpen();
  const s = now();
  const item = itemAt(shownItems(s, bar), path);
  if (!item || item.separator || item.submenu) throw new OpError("no_window", "There's no menu bar item at that path; menus.bar lists them.");
  if (item.ref !== ref) throw new OpError("refused", "The menu bar changed since it was read; read it again with menus.bar.");
  if (window !== null && !eligibleKind(s, window)) throw new OpError("refused", "That window isn't one the ardia command may use.");
  if (item.action && APP_WIDE_ACTIONS.has(item.action) && privateOpen(s)) {
    throw new OpError("refused", `${item.title} acts on every window, and a private window is open.`);
  }
  if (typeof item.command === "string") {
    await stillOpen();
    await nativeCall(() => checkMenuBarItem(menuId, path, ref));
    rightBeforeRun();
    const ran = runMethod({ command: item.command, arg: item.arg ?? null, window, tab: null }, surfaceRunMode.background);
    if ("error" in ran) {
      const { code, message } = ran.error as { code: OpError["code"]; message: string };
      throw new OpError(code, message);
    }
    return { title: item.title, command: item.command };
  }
  if (surfaceRunMode.background) throw new OpError("refused", NATIVE_ITEMS_NEED_VISIBLE);
  const target = window ?? lastFocusedEligibleWindow(s);
  if (!target) throw new OpError("no_window", "No window the ardia command may use is focused.");
  await stillOpen();
  const title = await nativeCall(() => performMenuBarItem(menuId, path, ref, target));
  return { title, action: item.action ?? null };
}

async function runBarItem(params: Record<string, unknown>, call: SocketCall) {
  return { ok: true, ...(await runBarEntry(null, params.path as number[], params.ref as string, (params.window as string | undefined) ?? null, call)) };
}

const MENU = id("A menu id from menus.open");
const PATH = { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: 8, description: "The item's path, as menus.open or menus.bar gives it" } as const;
const REF = text("The item's ref, as menus.open or menus.bar gives it: its command or action and its titles, so a menu rebuilt since can't run another item");

export const SURFACE_METHODS: MethodSpec[] = [
  {
    name: "menus.open",
    mutates: false,
    description: "Menus open now (a page's <select> popup or context menu, an Ardia menu, the menu bar) with their items",
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
    description: "Choose a menu bar item while the menu bar tracks, by its path and ref, under the same rules as menus.runBar; the menu closes. Picks from a page's menu, a <select> popup, a captured page menu or Ardia's own menus are refused",
    params: obj({ menu: MENU, path: PATH, ref: REF }, ["menu", "path"]),
    result: "{ok, menu, kind, title}",
    run: choose,
  },
  {
    name: "menus.dismiss",
    mutates: true,
    description: "Close an open menu without choosing, as Escape or a click away does",
    params: obj({ menu: MENU }, ["menu"]),
    result: "{ok}",
    run: dismiss,
  },
  {
    name: "menus.bar",
    mutates: false,
    description: "The menu bar's structure: every menu and item with its path, ref, static title, shortcut, and its command when run takes it, or its action; no enabled, checked or page-derived state. Refused while any private window is open",
    params: obj({}),
    result: "[{path, ref, title, separator, key?, command?, arg?, action?, boundWindow?, submenu?}]",
    run: async () => {
      if (privateOpen(now())) throw new OpError("refused", REFLECTS_PRIVATE);
      return shownItems(now(), await nativeCall(() => menuBar()));
    },
  },
  {
    name: "menus.runBar",
    mutates: true,
    description: "Run a menu bar item: an Ardia command goes through run and its policy (Open File is refused: it needs the person); a window item (Minimize, Zoom, Enter Full Screen, Minimize All, Arrange in Front) goes to the named key window or the app. Refused while any private window is open, for every native item in a background Ardia, and for Quit, Hide, Close Window, updates and items that only act through the responder chain",
    params: obj({ path: PATH, ref: REF, window: text("The window to run it in; the last focused one when left out. Window items act only when it is the key window and the item can be sent to that window itself; Minimize All and Arrange in Front are refused while a private window is open") }, ["path", "ref"]),
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
