import { useMemo } from "react";
import type { MaterialScheme } from "../../lib/material/schemes";
import { schemeFor, schemePairFor } from "../../lib/material/schemePick";
import { useDynamicScheme } from "../../state/app/dynamicScheme";
import { currentDarkScheme, useAppearanceDesign, useDarkScheme } from "../../state/settings/appearance";
import { currentPreferences, usePreferences } from "../../state/settings/store";

export type MaterialTheme = { scheme: MaterialScheme; dark: boolean };

export function useMaterialSchemePair() {
  const choice = usePreferences((p) => p.colorChoice);
  const dynamic = useDynamicScheme((s) => s.pair);
  return useMemo(() => schemePairFor(choice, dynamic), [choice, dynamic]);
}

export function useMaterialTheme(): MaterialTheme {
  const dark = useDarkScheme();
  const choice = usePreferences((p) => p.colorChoice);
  const dynamic = useDynamicScheme((s) => s.pair);
  return useMemo(() => ({ scheme: schemeFor(schemePairFor(choice, dynamic), dark), dark }), [choice, dynamic, dark]);
}

export function currentMaterialTheme(): MaterialTheme {
  const dark = currentDarkScheme();
  return { scheme: schemeFor(schemePairFor(currentPreferences().colorChoice, useDynamicScheme.getState().pair), dark), dark };
}

export const materialDesignApplied = () => useAppearanceDesign.getState().design === "material";
