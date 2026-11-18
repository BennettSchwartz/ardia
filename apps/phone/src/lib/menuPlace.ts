export type Rect = { x: number; y: number; width: number; height: number };

export type Point = { x: number; y: number };

export type MenuSpot = { left: number; top: number; height: number; origin: string };

export const MENU_ROW = 42;
export const MENU_HEADING = 30;
export const MENU_DIVIDER = 20.67;
export const MENU_PADDING = 19;
export const MENU_MARGIN = 8;

type Entry = "divider" | { heading: string } | object;

const entryHeight = (item: Entry) => (item === "divider" ? MENU_DIVIDER : "heading" in (item as object) ? MENU_HEADING : MENU_ROW);

export function menuHeight(items: readonly Entry[]): number {
  return items.reduce<number>((sum, item) => sum + entryHeight(item), MENU_PADDING);
}

export function tallestMenuPage(items: readonly Entry[]): number {
  return items.reduce<number>((tallest, item) => {
    const children = typeof item === "object" && "children" in (item as object) ? (item as { children: readonly Entry[] }).children : null;
    return children ? Math.max(tallest, MENU_ROW + menuHeight(children), tallestMenuPage(children)) : tallest;
  }, menuHeight(items));
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

export function menuOnTrigger(anchor: Rect, host: Rect, room: Rect, width: number, wanted: number, margin: number): MenuSpot {
  const roomTop = room.y + margin;
  const roomBottom = room.y + room.height - margin;
  const height = Math.min(wanted, roomBottom - roomTop);
  const trailing = anchor.x + anchor.width / 2 > room.x + room.width / 2;
  const x = clamp(trailing ? anchor.x + anchor.width - width : anchor.x, room.x + margin, room.x + room.width - width - margin);
  const anchorBottom = anchor.y + anchor.height;
  const below = anchor.y + height <= roomBottom || anchorBottom - height < roomTop;
  const y = clamp(below ? anchor.y : anchorBottom - height, roomTop, roomBottom - height);
  return { left: x - host.x, top: y - host.y, height, origin: `${trailing ? "right" : "left"} ${below ? "top" : "bottom"}` };
}

export function menuAt(point: Point, host: Rect, room: Rect, width: number, wanted: number, margin: number): MenuSpot {
  const roomTop = room.y + margin;
  const roomBottom = room.y + room.height - margin;
  const height = Math.min(wanted, roomBottom - roomTop);
  const fitsRight = point.x + width + margin <= room.x + room.width;
  const fitsBelow = point.y + height <= roomBottom;
  const x = clamp(fitsRight ? point.x : point.x - width, room.x + margin, room.x + room.width - width - margin);
  const y = clamp(fitsBelow ? point.y : point.y - height, roomTop, roomBottom - height);
  return { left: x - host.x, top: y - host.y, height, origin: `${fitsRight ? "left" : "right"} ${fitsBelow ? "top" : "bottom"}` };
}

export function insetRect(rect: Rect, inset: { top: number; bottom: number; left: number; right: number }): Rect {
  return { x: rect.x + inset.left, y: rect.y + inset.top, width: rect.width - inset.left - inset.right, height: rect.height - inset.top - inset.bottom };
}
