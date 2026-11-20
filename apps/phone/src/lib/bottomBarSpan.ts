export type BarSpan = { left: number; right: number };

export type ScreenHinge = "none" | "closed" | "partiallyOpen" | "fullyOpen";

export type DuoStrip = { side: "left" | "right"; centerX: number };

export type BottomBarLayout = { span: BarSpan; strip: DuoStrip | null };

export const DUO_BAR = { openFrom: 600, openWidth: 400, stripGap: 12, button: 48, axis: 48, buttonGap: 7, menuGap: 8 } as const;

export const DUO_PLUS_ABOVE = DUO_BAR.button + DUO_BAR.buttonGap;

export function bottomBarLayout(width: number, insets: { left: number; right: number }, hinge: ScreenHinge, side: number): BottomBarLayout {
  if (hinge === "none") {
    const safe = Math.max(insets.left, insets.right) + side;
    return { span: { left: safe, right: safe }, strip: null };
  }
  const stripLeft = insets.left > insets.right;
  const inset = stripLeft ? insets.left : insets.right;
  const near = inset + DUO_BAR.stripGap;
  const far = width < DUO_BAR.openFrom ? side : Math.max(side, width - near - DUO_BAR.openWidth);
  const fromEdge = Math.max(DUO_BAR.button / 2, Math.min(DUO_BAR.axis, inset - DUO_BAR.button / 2));
  return stripLeft ? { span: { left: near, right: far }, strip: { side: "left", centerX: fromEdge } } : { span: { left: far, right: near }, strip: { side: "right", centerX: width - fromEdge } };
}

export type DuoSqueeze = { marginLeft: number; marginRight: number };

export function duoSqueeze(width: number, layout: BottomBarLayout): DuoSqueeze | null {
  const { span, strip } = layout;
  if (!strip) return null;
  const half = DUO_BAR.button / 2;
  return { marginLeft: strip.centerX - half - span.left, marginRight: width - span.right - (strip.centerX + half) };
}

export const barSpanCenter = (width: number, span: BarSpan) => (span.left + width - span.right) / 2;

export function besideStrip(strip: DuoStrip, width: number, menuWidth: number, margin: number) {
  const away = DUO_BAR.button / 2 + DUO_BAR.menuGap;
  const room = (strip.side === "right" ? strip.centerX : width - strip.centerX) - away - margin;
  const fitted = Math.max(Math.min(menuWidth, room), 0);
  return strip.side === "right" ? { right: width - strip.centerX + away, width: fitted } : { left: strip.centerX + away, width: fitted };
}
