import { SEEDED_SCHEMES, type MaterialScheme, type MaterialSchemePair } from "./schemes.ts";

export type MaterialSeed = keyof typeof SEEDED_SCHEMES;

export const MATERIAL_FALLBACK_SEED: MaterialSeed = "ardia";

export function schemePairFor(choice: string | null, dynamic: MaterialSchemePair | null): MaterialSchemePair {
  if (choice && choice in SEEDED_SCHEMES && choice !== MATERIAL_FALLBACK_SEED) return SEEDED_SCHEMES[choice as MaterialSeed];
  return dynamic ?? SEEDED_SCHEMES[MATERIAL_FALLBACK_SEED];
}

export const schemeFor = (pair: MaterialSchemePair, dark: boolean): MaterialScheme => (dark ? pair.dark : pair.light);

