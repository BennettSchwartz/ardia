import { createContext, useContext, useEffect, useReducer, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { markHoverProps } from "../../lib/hoverMarks";
import { currentWindow } from "../../state/browser/current";
import { PageProfileContext, useSettings, useWindow } from "../../state/browser/hooks";
import { useBrowser } from "../../state/browser/store";
import {
  cardEntered,
  cardLaidOut,
  cardLeft,
  dropHeldEnter,
  holdEnterWhileScrolling,
  releaseAnchor,
  rowEntered,
  rowLeft,
  rowShown,
  rowsCovered,
  setGroupPointed,
  watchCovered,
  type HoverPointerEvent,
} from "../../state/sidebar/hover";
import type { Target } from "../../state/sidebar/sidebarUi";
import { useMedia, usePinnedWithMediaControls } from "../../state/media/media";

export const FoldedAway = createContext(false);

export const cardHoverProps = {
  onMouseEnter: cardEntered,
  onMouseLeave: cardLeft,
  onLayout: (e: LayoutChangeEvent) => cardLaidOut(e.nativeEvent.layout),
};

export function useCardTarget<T extends Target>(target: T | null): T | null {
  const cards = useSettings((s) => s.showTabHoverMenu);
  const playerTab = !cards && target?.kind === "tab" ? target.id : undefined;
  const pinned = usePinnedWithMediaControls(playerTab);
  const playing = useMedia((m) => {
    const session = playerTab ? m.sessions[playerTab] : undefined;
    return !!session && session.controllable && session.playbackState !== "none" && !!(session.title || session.artwork);
  });
  return cardTargetFor(target, cards, pinned && playing);
}

function cardTargetFor<T extends Target>(target: T | null, cards: boolean, player: boolean): T | null {
  if (cards || !target || player) return target;
  return target.kind === "tab" || target.kind === "folder" ? null : target;
}

function playerShowing(tabId: string): boolean {
  const session = useMedia.getState().sessions[tabId];
  return !!session && session.controllable && session.playbackState !== "none" && !!(session.title || session.artwork);
}

export function cardTargetNow<T extends Target>(target: T | null): T | null {
  const cards = useBrowser.getState().settings.showTabHoverMenu;
  const playerTab = !cards && target?.kind === "tab" ? target.id : undefined;
  const player = !!playerTab && !!useBrowser.getState().tabs[playerTab]?.pin && playerShowing(playerTab);
  return cardTargetFor(target, cards, player);
}

export type RowHoverCell = {
  hovered: boolean;
  plain: boolean;
  windowId: string;
  readers: Set<() => void>;
  set(hovered: boolean): void;
  refresh(): void;
};

export function rowHoverCell(windowId: string): RowHoverCell {
  const cell: RowHoverCell = {
    hovered: false,
    plain: true,
    windowId,
    readers: new Set(),
    set(hovered) {
      if (cell.hovered === hovered) return;
      cell.hovered = hovered;
      cell.refresh();
    },
    refresh() {
      for (const reader of cell.readers) reader();
    },
  };
  return cell;
}

export const cellHovered = (cell: RowHoverCell) => cell.hovered && !rowsCovered(cell.windowId);

export function useCellHovered(cell: RowHoverCell): boolean {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const seen = useRef(cellHovered(cell));
  seen.current = cellHovered(cell);
  useEffect(() => {
    cell.readers.add(refresh);
    if (seen.current !== cellHovered(cell)) refresh();
    return () => void cell.readers.delete(refresh);
  }, [cell]);
  return seen.current;
}

export function useRowHover(windowId: string, rowTarget: Target | null) {
  const { cell, hoverProps } = useRowHoverCell(windowId, rowTarget);
  return { hovered: useCellHovered(cell), hoverProps };
}

export function useRowHoverCell(windowId: string, rowTarget: Target | null) {
  const [cell] = useState(() => rowHoverCell(windowId));
  cell.windowId = windowId;
  const setHovered = cell.set;
  const refresh = cell.refresh;
  const page = useContext(PageProfileContext);
  const away = useContext(FoldedAway);
  const latest = useRef({ windowId, rowTarget, page, away });
  latest.current = { windowId, rowTarget, page, away };
  const entered = useRef<Target | null>(null);
  const inside = useRef<HoverPointerEvent | null>(null);
  const [row] = useState(() => ({}));
  const onCurrentPage = () => {
    const { windowId, page } = latest.current;
    return !page || currentWindow(windowId)?.profileId === page;
  };
  const [enterRow] = useState(() => (event?: HoverPointerEvent) => {
    if (!onCurrentPage() || latest.current.away) return;
    const windowId = latest.current.windowId;
    const target = cardTargetNow(latest.current.rowTarget);
    entered.current = target;
    if (holdEnterWhileScrolling(windowId, row, () => inside.current && enterRow(inside.current))) return;
    watchCovered(windowId, refresh, true);
    const enter = () => {
      if (latest.current.away) return;
      setHovered(true);
      rowShown(windowId, target);
    };
    rowEntered(windowId, target, event, enter, () => setHovered(true));
  });
  const [hoverProps] = useState(() =>
    markHoverProps({
      onMouseEnter: (event?: HoverPointerEvent) => {
        inside.current = { nativeEvent: { screenX: event?.nativeEvent?.screenX, screenY: event?.nativeEvent?.screenY } };
        enterRow(event);
      },
      onMouseLeave: (event?: HoverPointerEvent) => {
        inside.current = null;
        const windowId = latest.current.windowId;
        if (dropHeldEnter(windowId, row)) return;
        setHovered(false);
        watchCovered(windowId, refresh, false);
        rowLeft(windowId, entered.current, event, onCurrentPage());
      },
    }),
  );
  const shownAway = useRef(away);
  useEffect(() => {
    if (shownAway.current === away) return;
    shownAway.current = away;
    if (!away) {
      if (inside.current) enterRow(inside.current);
      return;
    }
    const { windowId, rowTarget } = latest.current;
    setHovered(false);
    watchCovered(windowId, refresh, false);
    if (rowTarget) releaseAnchor(windowId, rowTarget.id);
  }, [away]);
  useEffect(
    () => () => {
      const { windowId, rowTarget } = latest.current;
      watchCovered(windowId, refresh, false);
      if (rowTarget) releaseAnchor(windowId, rowTarget.id);
    },
    [],
  );
  return { cell, hoverProps };
}

export function useGroupHover(windowId: string, groupId: string) {
  const [inside, setInside] = useState(false);
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const page = useContext(PageProfileContext);
  const away = useContext(FoldedAway);
  const onPage = useWindow(windowId, (w) => !page || w?.profileId === page);
  const windowRef = useRef(windowId);
  windowRef.current = windowId;
  const [hoverProps] = useState(() => {
    const row = {};
    return markHoverProps({
      onMouseEnter: () => {
        if (!holdEnterWhileScrolling(windowRef.current, row, () => setInside(true))) setInside(true);
      },
      onMouseLeave: () => {
        if (!dropHeldEnter(windowRef.current, row)) setInside(false);
      },
    });
  });
  useEffect(() => {
    watchCovered(windowId, refresh, true);
    return () => watchCovered(windowId, refresh, false);
  }, [windowId]);
  const hovered = inside && onPage && !away && !rowsCovered(windowId);
  useEffect(() => {
    if (!hovered) return;
    setGroupPointed(groupId, true);
    return () => setGroupPointed(groupId, false);
  }, [hovered, groupId]);
  return { hovered, hoverProps };
}
