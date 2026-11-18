import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ScrollView } from "react-native";
import { forgetSettingsScroll, noteSettingsScrollOffset, settingsScrollFor } from "../../state/settings/settingsWindows";
import { holdAfterScroll, holdTarget, startScrollHold, type ScrollHold } from "../../state/settings/scrollHold";

export function useSettingsScrollMemory(visit: number | null, scroller: RefObject<ScrollView | null>) {
  const hold = useRef<ScrollHold | null>(null);
  const shownVisit = useRef(-1);
  useLayoutEffect(() => {
    if (visit === null) return;
    shownVisit.current = visit;
    const y = settingsScrollFor(visit);
    hold.current = startScrollHold(y, Date.now());
    noteSettingsScrollOffset(visit, y);
    scroller.current?.scrollTo({ y, animated: false });
  }, [visit]);
  useEffect(() => forgetSettingsScroll, []);
  return {
    onScroll(y: number, viewport: number, content: number) {
      noteSettingsScrollOffset(shownVisit.current, y);
      hold.current = holdAfterScroll(hold.current, y, content - viewport, Date.now());
    },
    onContentSizeChange() {
      const target = holdTarget(hold.current, Date.now());
      if (target === null) hold.current = null;
      else scroller.current?.scrollTo({ y: target, animated: false });
    },
    endHold() {
      hold.current = null;
    },
  };
}
