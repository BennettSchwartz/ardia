import type { ViewStyle } from "react-native";

export type Flat = ViewStyle & Record<string, unknown>;

export type Backed = { fill: Flat; own: Flat };

export type ColorDraws = (color: unknown) => boolean;

const SHADOW_KEYS = ["shadowColor", "shadowOpacity", "shadowRadius", "shadowOffset", "boxShadow"];

const CLEAR = "transparent";

export const drawsByName: ColorDraws = (color) => color != null && color !== CLEAR;

export const processedColorDraws = (processed: unknown) => processed != null && (typeof processed !== "number" || processed >>> 24 !== 0);

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

const bordered = (flat: Flat) => Object.values(borderWidths(flat)).some((side) => side > 0);

function ownWithoutPaint(style: Flat, clearBorder: boolean): Flat {
  const own: Flat = {};
  for (const key of Object.keys(style)) if (key !== "backgroundColor" && !isBorderColor(key)) own[key] = style[key];
  if (clearBorder) own.borderColor = CLEAR;
  return own;
}

function fillOf(flat: Flat): Flat {
  const sides = borderWidths(flat);
  const fill: Flat = { position: "absolute", top: outward(sides.top), bottom: outward(sides.bottom), left: outward(sides.left), right: outward(sides.right), backgroundColor: flat.backgroundColor ?? CLEAR };
  for (const key of Object.keys(flat)) if (isBorderKey(key)) fill[key] = flat[key];
  return fill;
}

function fillCannotMatch(flat: Flat) {
  if (SHADOW_KEYS.some((key) => flat[key] != null)) return true;
  if (flat.position === "static" || flat.direction === "rtl") return true;
  return Object.keys(flat).some((key) => key.startsWith("outline"));
}

export function backedStyles(flat: Flat, draws: ColorDraws = drawsByName): Backed | null {
  if (!draws(flat.backgroundColor) || fillCannotMatch(flat)) return null;
  return { fill: fillOf(flat), own: ownWithoutPaint(flat, bordered(flat)) };
}

export const touchesFill = (style: Flat) => Object.keys(style).some((key) => key === "backgroundColor" || isBorderKey(key));

export function routedNativeStyle(latest: Flat, style: Flat): Backed & { latest: Flat } {
  const merged: Flat = { ...latest, ...style };
  return { latest: merged, fill: fillOf(merged), own: ownWithoutPaint(style, bordered(merged)) };
}

export type PointerEvents = "auto" | "none" | "box-none" | "box-only" | undefined;

export const fillPointerEvents = (outer: PointerEvents): PointerEvents => (outer === "none" || outer === "box-none" ? "none" : undefined);
