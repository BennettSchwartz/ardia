import type { ViewStyle } from "react-native";

export type Flat = ViewStyle & Record<string, unknown>;

const RADII = [
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderTopStartRadius",
  "borderTopEndRadius",
  "borderBottomStartRadius",
  "borderBottomEndRadius",
  "borderStartStartRadius",
  "borderStartEndRadius",
  "borderEndStartRadius",
  "borderEndEndRadius",
] as const;

const width = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export function backgroundFill(flat: Flat): ViewStyle | null {
  const color = flat.backgroundColor;
  if (color == null || color === "transparent") return null;
  const all = width(flat.borderWidth, 0);
  const top = width(flat.borderTopWidth, all);
  const bottom = width(flat.borderBottomWidth, all);
  const left = width(flat.borderLeftWidth, width(flat.borderStartWidth, all));
  const right = width(flat.borderRightWidth, width(flat.borderEndWidth, all));
  const thickest = Math.max(top, bottom, left, right);
  const fill: Flat = { position: "absolute", top, bottom, left, right, backgroundColor: color };
  for (const key of RADII) {
    const radius = flat[key];
    if (typeof radius === "number") fill[key] = Math.max(0, radius - thickest);
  }
  if (flat.borderCurve) fill.borderCurve = flat.borderCurve;
  return fill;
}
