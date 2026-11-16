import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { SafeAreaInsetsContext, type EdgeInsets } from "react-native-safe-area-context";

export const INSET_DROP_HOLD_MS = 1000;

const atLeast = (shown: EdgeInsets, live: EdgeInsets): EdgeInsets => {
  const next = { top: Math.max(shown.top, live.top), right: Math.max(shown.right, live.right), bottom: Math.max(shown.bottom, live.bottom), left: Math.max(shown.left, live.left) };
  return next.top === shown.top && next.right === shown.right && next.bottom === shown.bottom && next.left === shown.left ? shown : next;
};

const same = (a: EdgeInsets | null, b: EdgeInsets | null) => a === b || (!!a && !!b && a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left);

export function SteadyInsets({ children }: { children: ReactNode }) {
  const live = useContext(SafeAreaInsetsContext);
  const latest = useRef(live);
  latest.current = live;
  const [shown, setShown] = useState(live);
  useEffect(() => {
    if (!live) return;
    setShown((previous) => (previous ? atLeast(previous, live) : live));
    const settle = setTimeout(() => setShown((previous) => (same(previous, latest.current) ? previous : latest.current)), INSET_DROP_HOLD_MS);
    return () => clearTimeout(settle);
  }, [live?.top, live?.right, live?.bottom, live?.left]);
  if (Platform.OS !== "android") return <>{children}</>;
  return <SafeAreaInsetsContext.Provider value={shown}>{children}</SafeAreaInsetsContext.Provider>;
}
