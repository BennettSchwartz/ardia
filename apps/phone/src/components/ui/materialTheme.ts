import { useMemo } from "react";
import type { MaterialScheme } from "../../lib/material/schemes";
import { schemeFor, schemePairFor } from "../../lib/material/schemePick";
import { useDynamicScheme } from "../../state/app/dynamicScheme";
import { currentDarkScheme, useAppearanceDesign, useDarkScheme } from "../../state/settings/appearance";
import { currentPreferences, usePreferences } from "../../state/settings/store";

export type MaterialTheme = { scheme: MaterialScheme; dark: boolean };

export function useMaterialSchemePair() {
  const choice = usePreferences((p) => p.colorChoice);
  const enabled = usePreferences((p) => p.dynamicColors);
  const dynamic = useDynamicScheme((s) => s.pair);
  return useMemo(() => schemePairFor(choice, dynamic, enabled), [choice, dynamic, enabled]);
}

export function useMaterialTheme(): MaterialTheme {
  const dark = useDarkScheme();
  const pair = useMaterialSchemePair();
  return useMemo(() => ({ scheme: schemeFor(pair, dark), dark }), [pair, dark]);
}

export function currentMaterialTheme(): MaterialTheme {
  const dark = currentDarkScheme();
  const { colorChoice, dynamicColors } = currentPreferences();
  return { scheme: schemeFor(schemePairFor(colorChoice, useDynamicScheme.getState().pair, dynamicColors), dark), dark };
}

export const materialDesignApplied = () => useAppearanceDesign.getState().design === "material";
