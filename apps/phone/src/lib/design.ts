export type Design = "original" | "redesigned" | "material";

export const DESIGNS: readonly Design[] = ["original", "redesigned"];

export const designFor = (os: string, labRedesign = false): Design => (os === "ios" || labRedesign ? "redesigned" : "material");
