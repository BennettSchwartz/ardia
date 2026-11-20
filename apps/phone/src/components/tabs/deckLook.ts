import { shape } from "../ui";

export const deckLook = {
  buttonCorner: shape.control,
  fieldCorner: shape.field,
  archiveCorner: shape.card,
  archiveClearance: 12,
  archiveShadow: "0px 8px 24px rgba(0,0,0,0.12)",
  archiveShadowDark: "0px 8px 24px rgba(0,0,0,0.4)",
} as const;
