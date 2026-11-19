import { nativeModule, type OpenSurface, type SurfaceEvent, type SurfaceItem } from "@ardia/shell";

export type { OpenSurface, SurfaceEvent, SurfaceItem };

const Menus = () => nativeModule("ArdiaMenus");

export const openSurfaces = () => Menus().openSurfaces();
export const holdPageMenus = (holds: boolean) => Promise.resolve().then(() => Menus().holdPageMenus(holds));
export const chooseSurfaceItem = (id: string, path: number[]) => Menus().chooseSurfaceItem(id, path);
export const dismissSurface = (id: string) => Menus().dismissSurface(id);
export const chooseColor = (id: string, hex: string, close: boolean) => Menus().chooseColor(id, hex, close);
export const menuBar = () => Menus().menuBar();
export const performMenuBarItem = (path: number[]) => Menus().performMenuBarItem(path);
export const onSurface = (listener: (e: SurfaceEvent) => void) => Menus().addListener("onSurface", listener);
