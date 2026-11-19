export type BarSpan = { left: number; right: number };

export type ScreenHinge = "none" | "closed" | "partiallyOpen" | "fullyOpen";

export const DUO_BAR = { openFrom: 600, openWidth: 400, stripGap: 12 } as const;

export function bottomBarSpan(width: number, insets: { left: number; right: number }, hinge: ScreenHinge, side: number): BarSpan {
  if (hinge === "none") {
    const safe = Math.max(insets.left, insets.right) + side;
    return { left: safe, right: safe };
  }
  if (width < DUO_BAR.openFrom) return { left: side, right: side };
  const stripLeft = insets.left > insets.right;
  const near = (stripLeft ? insets.left : insets.right) + DUO_BAR.stripGap;
  const far = Math.max(side, width - near - DUO_BAR.openWidth);
  return stripLeft ? { left: near, right: far } : { left: far, right: near };
}

export const barSpanCenter = (width: number, span: BarSpan) => (span.left + width - span.right) / 2;
