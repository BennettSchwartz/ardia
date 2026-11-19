import { checkMenuBarItem, chooseSurfaceItem, dismissSurface, menuBar, onSurface, openSurfaces, performMenuBarItem, type OpenSurface, type SurfaceEvent, type SurfaceItem } from "../../platform/surfaces";
import type { BrowserState } from "../browser/store";
import { eligibleKind, isEligibleTab, lastFocusedEligibleWindow } from "./automationWindows";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { id, obj, text } from "./socketSchema";
import { now } from "./socketTargets";
import type { EventSend } from "./storeEvents";
import { OpError } from "./workspaceTargets";
import { runMethod } from "./controlSocket";

const PAGE_KINDS: ReadonlySet<string> = new Set(["select", "page"]);

export function visibleSurface(s: BrowserState, surface: OpenSurface): (Omit<OpenSurface, "window" | "tab"> & { window: string; tab: string | null }) | null {
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
  const s = now();
  const found = (await openSurfaces()).map((m) => visibleSurface(s, m)).find((m) => m?.id === menuId);
  if (!found) throw new OpError("no_window", `There's no open menu ${menuId}; menus.open lists them.`);
  return found;
}

async function choose(params: Record<string, unknown>, call: SocketCall) {
  const surface = await surfaceOf(params.menu as string);
  const path = params.path as number[];
  if (surface.kind === "menuBar") {
    if (typeof params.ref !== "string") throw new OpError("bad_request", "A menu bar item is chosen by its ref as well as its path; menus.open and menus.bar give both.");
    const ran = await runBarEntry(path, params.ref, surface.window, call);
    await dismissSurface(surface.id).catch(() => undefined);
    return { ok: true, menu: surface.id, kind: surface.kind, ...ran };
  }
  if (!PAGE_KINDS.has(surface.kind)) throw new OpError("refused", "Only a page's menus and the menu bar are chosen from here; Ardia's own menus stay with you.");
  call.stillServing();
  const title = await nativeCall(() => chooseSurfaceItem(surface.id, path));
  return { ok: true, menu: surface.id, kind: surface.kind, title };
}

async function dismiss(params: Record<string, unknown>, call: SocketCall) {
  const surface = await surfaceOf(params.menu as string);
  call.stillServing();
  await nativeCall(() => dismissSurface(surface.id));
  return { ok: true };
}

function itemAt(items: SurfaceItem[], path: number[]): SurfaceItem | undefined {
  let level: SurfaceItem[] | undefined = items;
  let found: SurfaceItem | undefined;
  for (const step of path) {
    found = level?.find((item) => item.path[item.path.length - 1] === step);
    level = found?.submenu;
  }
  return found && found.path.length === path.length ? found : undefined;
}

async function runBarEntry(path: number[], ref: string, window: string | null, call: SocketCall) {
  const item = itemAt(await menuBar(), path);
  if (!item || item.separator || item.submenu) throw new OpError("no_window", "There's no menu bar item at that path; menus.bar lists them.");
  if (item.ref !== ref) throw new OpError("refused", "The menu bar changed since it was read; read it again with menus.bar.");
  if (!item.enabled) throw new OpError("refused", `${item.title} is turned off.`);
  const s = now();
  if (window !== null && !eligibleKind(s, window)) throw new OpError("refused", "That window isn't one the ardia command may use.");
  call.stillServing();
  if (typeof item.command === "string") {
    await nativeCall(() => checkMenuBarItem(path, ref));
    const ran = runMethod({ command: item.command, arg: item.arg ?? null, window, tab: null });
    if ("error" in ran) {
      const { code, message } = ran.error as { code: OpError["code"]; message: string };
      throw new OpError(code, message);
    }
    return { title: item.title, command: item.command };
  }
  const target = window ?? lastFocusedEligibleWindow(s);
  if (!target) throw new OpError("no_window", "No window the ardia command may use is focused.");
  const title = await nativeCall(() => performMenuBarItem(path, ref, target));
  return { title, action: item.action ?? null };
}

async function runBarItem(params: Record<string, unknown>, call: SocketCall) {
  return { ok: true, ...(await runBarEntry(params.path as number[], params.ref as string, (params.window as string | undefined) ?? null, call)) };
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
    description: "Choose an item in an open menu, as a click on it does; the menu closes. A menu bar item needs its ref and goes through the same rules as menus.runBar; Ardia's own menus are refused",
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
    description: "The menu bar as Ardia shows it now: every menu and item with its path, enabled and checked state, shortcut, and its command when run takes it",
    params: obj({}),
    result: "[{path, ref, title, enabled, checked, key?, command?, arg?, action?, submenu?}]",
    run: () => menuBar(),
  },
  {
    name: "menus.runBar",
    mutates: true,
    description: "Run a menu bar item: an Ardia command goes through run, an editing or window item (Copy, Paste, Undo, Minimize) through the menu itself; Quit, Hide, Close Window and updates are refused",
    params: obj({ path: PATH, ref: REF, window: text("The window to run it in; the focused one when left out. Editing and window items act only when it is the focused window") }, ["path", "ref"]),
    result: "{ok, title, command? | action?}",
    run: runBarItem,
  },
];

const EVENT_OF: Record<SurfaceEvent["type"], "menu.opened" | "menu.closed"> = { menuOpened: "menu.opened", menuClosed: "menu.closed" };

export function startSurfaceEvents(send: EventSend, wants: ReadonlySet<string>) {
  const shown = new Set<string>();
  const sub = onSurface((event) => {
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
