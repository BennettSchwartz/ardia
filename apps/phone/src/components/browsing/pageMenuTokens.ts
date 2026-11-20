import { shape } from "../ui";

export const pageMenuCardInk = {
  light: { sheet: "#F2F2F7", card: "#FFFFFF", rowPressed: "rgba(0,0,0,0.07)", separator: "rgba(60,60,67,0.18)", stepper: "rgba(118,118,128,0.12)" },
  dark: { sheet: "#000000", card: "#1C1C1E", rowPressed: "rgba(255,255,255,0.09)", separator: "rgba(84,84,88,0.5)", stepper: "rgba(118,118,128,0.24)" },
} as const;

export const pageMenuCards = {
  radius: shape.card,
  stepperRadius: shape.control,
  barHeight: 48,
  barButton: 44,
  tileHeight: 64,
  tileGlyph: 22,
  rowGlyph: 20,
  iconSlot: 26,
  rowInset: 16,
  iconGap: 14,
  stepperHeight: 34,
  stepperButton: 40,
  stepperReset: 52,
} as const;
