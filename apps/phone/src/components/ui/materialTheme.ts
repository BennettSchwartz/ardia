import { useMemo } from "react";
import type { MaterialScheme } from "../../lib/material/schemes";
import { schemeFor, schemePairFor } from "../../lib/material/schemePick";
import { useDynamicScheme } from "../../state/app/dynamicScheme";
import { useDarkScheme } from "../../state/settings/appearance";
import { usePreferences } from "../../state/settings/store";

export type MaterialTheme = { scheme: MaterialScheme; dark: boolean };

export function useMaterialTheme(): MaterialTheme {
  const dark = useDarkScheme();
  const choice = usePreferences((p) => p.colorChoice);
  const dynamic = useDynamicScheme((s) => s.pair);
  return useMemo(() => ({ scheme: schemeFor(schemePairFor(choice, dynamic), dark), dark }), [choice, dynamic, dark]);
}
