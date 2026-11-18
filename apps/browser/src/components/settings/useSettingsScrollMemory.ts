import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ScrollView } from "react-native";
import { forgetSettingsScroll, noteSettingsPageScroll, settingsScrollToRestore } from "../../state/settings/settingsWindows";

const RESTORE_WINDOW_MS = 1500;

type PendingRestore = { y: number; until: number };

export function useSettingsScrollMemory(page: string, scroller: RefObject<ScrollView | null>) {
  const pending = useRef<PendingRestore | null>(null);
  const pendingFor = () => {
    const p = pending.current;
    if (p && Date.now() > p.until) pending.current = null;
    return pending.current;
  };
  useLayoutEffect(() => {
    const y = settingsScrollToRestore(page);
    pending.current = y > 0 ? { y, until: Date.now() + RESTORE_WINDOW_MS } : null;
    noteSettingsPageScroll(page, y);
    scroller.current?.scrollTo({ y, animated: false });
  }, [page]);
  useEffect(() => forgetSettingsScroll, []);
  return {
    onOffset(y: number) {
      const p = pendingFor();
      if (p && Math.abs(y - p.y) < 1) pending.current = null;
      noteSettingsPageScroll(page, pending.current?.y ?? y);
    },
    onContentSizeChange() {
      const p = pendingFor();
      if (p) scroller.current?.scrollTo({ y: p.y, animated: false });
    },
  };
}
