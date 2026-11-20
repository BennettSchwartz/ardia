import type { ViewStyle } from "react-native";

export type Flat = ViewStyle & Record<string, unknown>;

export type Backed = { fill: Flat; own: Flat };

export type ColorDraws = (color: unknown) => boolean;

const SHADOW_KEYS = ["shadowColor", "shadowOpacity", "shadowRadius", "shadowOffset", "boxShadow"];

const CLEAR = "transparent";

export const drawsByName: ColorDraws = (color) => color != null && color !== CLEAR;

const isBorderKey = (key: string) => key.startsWith("border");

const isBorderColor = (key: string) => isBorderKey(key) && key.endsWith("Color");

const width = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function borderWidths(flat: Flat) {
  const all = width(flat.borderWidth, 0);
  return {
    top: width(flat.borderTopWidth, all),
    bottom: width(flat.borderBottomWidth, all),
    left: width(flat.borderStartWidth, width(flat.borderLeftWidth, all)),
    right: width(flat.borderEndWidth, width(flat.borderRightWidth, all)),
  };
}

const outward = (side: number) => -side || 0;

function ownWithoutPaint(style: Flat, bordered: boolean): Flat {
  const own: Flat = {};
  for (const key of Object.keys(style)) if (key !== "backgroundColor" && !isBorderColor(key)) own[key] = style[key];
  if (bordered) own.borderColor = CLEAR;
  return own;
}

export function backedStyles(flat: Flat, draws: ColorDraws = drawsByName): Backed | null {
  if (!draws(flat.backgroundColor)) return null;
  if (SHADOW_KEYS.some((key) => flat[key] != null)) return null;
  const sides = borderWidths(flat);
  const fill: Flat = { position: "absolute", top: outward(sides.top), bottom: outward(sides.bottom), left: outward(sides.left), right: outward(sides.right), backgroundColor: flat.backgroundColor };
  for (const key of Object.keys(flat)) if (isBorderKey(key)) fill[key] = flat[key];
  const bordered = sides.top > 0 || sides.bottom > 0 || sides.left > 0 || sides.right > 0;
  return { fill, own: ownWithoutPaint(flat, bordered) };
}

export const touchesFill = (style: Flat) => Object.keys(style).some((key) => key === "backgroundColor" || isBorderKey(key));

export function routedNativeStyle(latest: Flat, style: Flat, draws: ColorDraws = drawsByName): (Backed & { latest: Flat }) | null {
  const merged: Flat = { ...latest, ...style };
  const backed = backedStyles(merged, draws);
  if (!backed) return null;
  return { latest: merged, fill: backed.fill, own: ownWithoutPaint(style, backed.own.borderColor === CLEAR) };
}
