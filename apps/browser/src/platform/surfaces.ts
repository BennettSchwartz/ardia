import { nativeModule, type OpenSurface, type SurfaceEvent, type SurfaceItem } from "@ardia/shell";

export type { OpenSurface, SurfaceEvent, SurfaceItem };

const Menus = () => nativeModule("ArdiaMenus");

export const openSurfaces = () => Menus().openSurfaces();
export const capturePageMenus = (captures: boolean) => Promise.resolve().then(() => Menus().capturePageMenus(captures));
export const chooseSurfaceItem = (id: string, path: number[]) => Menus().chooseSurfaceItem(id, path);
export const dismissSurface = (id: string) => Menus().dismissSurface(id);
export const menuBar = () => Menus().menuBar();
export const performMenuBarItem = (menu: string | null, path: number[], ref: string, windowId: string) => Menus().performMenuBarItem(menu, path, ref, windowId);
export const checkMenuBarItem = (menu: string | null, path: number[], ref: string) => Menus().checkMenuBarItem(menu, path, ref);
export const onSurface = (listener: (e: SurfaceEvent) => void) => Menus().addListener("onSurface", listener);
