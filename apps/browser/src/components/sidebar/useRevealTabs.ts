import { useEffect, type RefObject } from "react";
import type { ScrollView } from "react-native";
import { prepareLanding, watchRevealTargets } from "../../state/sidebar/reveal";
import { reduceMotion } from "../ui";
import { GLOW_ROOM, type SidebarGeometry } from "./pageLayout";
import { locateTab } from "./selectedRow";
import { REVEAL_GLIDE } from "./tokens";

export function glideOffsets(from: number, to: number, elapsedMs: number): { y: number; done: boolean } {
  const progress = Math.min(1, Math.max(0, elapsedMs / REVEAL_GLIDE.duration));
  return { y: from + (to - from) * REVEAL_GLIDE.easing(progress), done: progress >= 1 };
}

export function stillOurs(sent: number[], origin: number, reported: number): number[] | null {
  if (!sent.length) return sent;
  for (let i = sent.length - 1; i >= 0; i--) if (Math.abs(reported - sent[i]!) <= 2) return sent.slice(i + 1);
  return Math.abs(reported - origin) <= 2 ? sent : null;
}

export const LANDING = { beyondScreens: 2, fromScreens: 1, waitMs: 250 } as const;

export function landingStart(from: number, to: number, viewport: number): number | null {
  if (viewport <= 0 || Math.abs(to - from) <= viewport * LANDING.beyondScreens) return null;
  return to + Math.sign(from - to) * viewport * LANDING.fromScreens;
}

export function useRevealTabs(windowId: string, scroll: RefObject<ScrollView | null>, scrollY: RefObject<number>, geometry: RefObject<SidebarGeometry>) {
  useEffect(() => {
    let switched: string | null = null;
    let opened: string | null = null;
    let frame = 0;
    let glide = 0;
    let reveals = 0;
    let landing: ReturnType<typeof setTimeout> | undefined;
    let sent: number[] = [];
    let origin = 0;
    const ours = () => {
      const left = stillOurs(sent, origin, scrollY.current ?? origin);
      if (left && left.length < sent.length) origin = sent[sent.length - left.length - 1]!;
      sent = left ?? [];
      return !!left;
    };
    const position = () => (ours() && sent.length ? sent.at(-1)! : (scrollY.current ?? 0));
    const place = (y: number) => {
      if (!sent.length) origin = scrollY.current ?? 0;
      sent.push(y);
      scroll.current?.scrollTo({ y, animated: false });
    };
    const stopGlide = () => {
      cancelAnimationFrame(glide);
      clearTimeout(landing);
      glide = 0;
    };
    const glideTo = (to: number, tabId: string) => {
      stopGlide();
      const from = position();
      if (reduceMotion() || Math.abs(to - from) < 1) return void place(to);
      const near = landingStart(from, to, geometry.current.viewport);
      if (near === null) return glideFrom(from, to);
      const mine = reveals;
      let went = false;
      const land = () => {
        if (went || mine !== reveals) return;
        went = true;
        clearTimeout(landing);
        if (Math.abs(position() - from) > 2) return;
        place(near);
        glideFrom(near, to);
      };
      if (!prepareLanding(windowId, tabId, land)) return glideFrom(from, to);
      landing = setTimeout(land, LANDING.waitMs);
    };
    const glideFrom = (from: number, to: number) => {
      const start = Date.now();
      const step = () => {
        if (!ours()) return void (glide = 0);
        const { y, done } = glideOffsets(from, to, Date.now() - start);
        place(y);
        glide = done ? 0 : requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    };
    const show = (tabId: string, y: number, height: number) => {
      const top = position();
      const { viewport, edgeLift = 0 } = geometry.current;
      if (y - top < GLOW_ROOM) glideTo(Math.max(0, y - GLOW_ROOM + edgeLift - REVEAL_GLIDE.margin), tabId);
      else if (y + height - top > viewport - GLOW_ROOM) glideTo(y + height - viewport + REVEAL_GLIDE.margin, tabId);
    };
    const reveal = () => {
      frame = 0;
      if (!geometry.current.viewport || !scroll.current) return;
      const mine = ++reveals;
      const tabId = switched ?? opened;
      switched = opened = null;
      if (!tabId) return;
      stopGlide();
      const row = locateTab(windowId, tabId, geometry.current, scroll.current, () => scrollY.current ?? 0);
      if (!row) return;
      if ("then" in row) void row.then((found) => found && mine === reveals && show(tabId, found.y, found.height));
      else show(tabId, row.y, row.height);
    };
    const schedule = () => {
      if ((switched || opened) && !frame) frame = requestAnimationFrame(reveal);
    };
    const unsubscribe = watchRevealTargets(windowId, (nowSwitched, nowOpened) => {
      if (nowSwitched) switched = nowSwitched;
      if (nowOpened) opened = nowOpened;
      schedule();
    });
    geometry.current.laidOut = schedule;
    return () => {
      cancelAnimationFrame(frame);
      stopGlide();
      unsubscribe();
      geometry.current.laidOut = undefined;
    };
  }, [windowId]);
}
