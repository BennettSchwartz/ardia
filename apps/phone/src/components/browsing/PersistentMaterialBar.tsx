import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type TextInputInstance } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useSurface } from "../../state/browse/hooks";
import { useSearchOpen } from "../../state/search/hooks";
import { useSelectedTab } from "../../state/tabs/hooks";
import { noteDeckBarTop, watchDeckBar } from "../../state/toasts/store";
import { MaterialBottomBar, type MaterialBottomBarProps } from "../ui/MaterialBottomBar";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialBottomBar } from "../ui/materialTokens";

type BarCollapse = {
  progress: SharedValue<number>;
  travel: number;
};

type Registration = {
  bar: MaterialBottomBarProps;
  gesture?: ReturnType<typeof Gesture.Race>;
  hidden?: boolean;
  blocked?: boolean;
  collapse?: BarCollapse;
  siteSettingsSheet?: ReactNode;
  tabId?: string;
  measure?: () => void;
};
type Entry = Registration & { owner: object };
type Slots = { page: Entry | null; deck: Entry | null; start: Entry | null };
const makeStore = () => createStore<Slots & { searchVisible: boolean }>(() => ({ page: null, deck: null, start: null, searchVisible: false }));
const BarContext = createContext<{ enabled: boolean; store: ReturnType<typeof makeStore> } | null>(null);
const noop = () => undefined;

export function MaterialBarProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [store] = useState(makeStore);
  const context = useMemo(() => ({ enabled, store }), [enabled, store]);
  return <BarContext.Provider value={context}>{children}</BarContext.Provider>;
}

export const useMaterialBarHosted = () => useContext(BarContext)?.enabled ?? false;

export function useMaterialSearchBarVisible() {
  const store = useContext(BarContext)?.store;
  useLayoutEffect(() => {
    store?.setState({ searchVisible: true });
    return () => { store?.setState({ searchVisible: false }); };
  }, [store]);
}

export function useMaterialBarRegistration(slot: keyof Slots, registration: Registration | null) {
  const context = useContext(BarContext);
  const owner = useRef({}).current;
  const store = context?.store;
  const enabled = context?.enabled ?? false;
  useLayoutEffect(() => {
    if (!store) return;
    if (enabled && registration) store.setState({ [slot]: { ...registration, owner } });
    else if (store.getState()[slot]?.owner === owner) store.setState({ [slot]: null });
  });
  useLayoutEffect(() => () => {
    if (store?.getState()[slot]?.owner === owner) store.setState({ [slot]: null });
  }, [store, slot, owner, enabled]);
  return enabled;
}

export function PersistentMaterialBar() {
  const context = useContext(BarContext);
  if (!context) return null;
  return <MaterialBarHost store={context.store} enabled={context.enabled} />;
}

function MaterialBarHost({ store, enabled }: { store: ReturnType<typeof makeStore>; enabled: boolean }) {
  const page = useStore(store, (state) => state.page);
  const deck = useStore(store, (state) => state.deck);
  const start = useStore(store, (state) => state.start);
  const searchVisible = useStore(store, (state) => state.searchVisible);
  const surface = useSurface();
  const tab = useSelectedTab();
  const searching = useSearchOpen();
  const insets = useSafeAreaInsets();
  const { scheme } = useMaterialTheme();
  const input = useRef<TextInputInstance>(null);
  const inertGesture = useMemo(() => Gesture.Pan().enabled(false).onStart(() => { "worklet"; }), []);
  const isTabOverview = surface === "deck";
  const isStart = surface === "start";
  const entry = isTabOverview ? deck : isStart ? start : page;
  const matches = isTabOverview || isStart || entry?.tabId === tab?.id;
  const searchPresented = searching || searchVisible;
  const pageSearch = !isTabOverview && !isStart && searchPresented;
  const hidden = !enabled || !entry || !matches || (searchPresented && !pageSearch) || entry.hidden;
  const blocked = hidden || searchPresented || entry?.blocked;
  const collapseProgress = entry?.collapse?.progress ?? null;
  const collapseTravel = entry?.collapse?.travel ?? 0;
  const hiddenValue = useSharedValue(0);
  const collapseActive = useSharedValue(0);
  const travelValue = useSharedValue(0);
  const collapseRevision = useSharedValue(0);
  useLayoutEffect(() => {
    hiddenValue.value = hidden ? 1 : 0;
    collapseActive.value = collapseProgress ? 1 : 0;
    travelValue.value = collapseTravel;
  }, [hidden, collapseProgress, collapseTravel, hiddenValue, collapseActive, travelValue]);
  const motionStyle = useAnimatedStyle(() => {
    if (hiddenValue.value || collapseRevision.value < 0) return { opacity: 0, transform: [{ translateY: 0 }] };
    const progress = collapseActive.value && collapseProgress ? collapseProgress.value : 0;
    return { opacity: 1 - progress, transform: [{ translateY: progress * travelValue.value }] };
  }, [collapseProgress]);
  useEffect(() => {
    collapseRevision.value += 1;
  }, [collapseProgress, collapseRevision]);
  const fallback: MaterialBottomBarProps = { isTabOverview: true, scheme, search: { input, text: "", focused: false, change: noop, focus: noop, blur: noop }, incognito: false, canReopen: false, menusShown: false, onMenu: noop };
  const registeredBar = entry?.bar ?? fallback;
  const bar = pageSearch && !registeredBar.isStart && !registeredBar.isTabOverview
    ? { ...registeredBar, addressDocked: true, showsPlus: true }
    : registeredBar;
  const container = bar.container;
  useLayoutEffect(() => {
    if (!enabled || !isTabOverview || hidden) noteDeckBarTop(null);
  }, [enabled, isTabOverview, hidden]);
  useLayoutEffect(() => {
    if (!enabled || !isTabOverview || hidden || !entry?.measure) return;
    const measure = entry.measure;
    watchDeckBar(measure);
    measure();
    return () => watchDeckBar(null);
  }, [enabled, isTabOverview, hidden, entry?.measure]);
  const barStyles = [
    styles.place,
    { bottom: insets.bottom + materialBottomBar.inset, left: Math.max(insets.left, insets.right) + materialBottomBar.edge, right: Math.max(insets.left, insets.right) + materialBottomBar.edge },
    ...(container?.style ? [container.style] : []),
    motionStyle,
    ...(hidden ? [styles.hidden] : []),
  ];
  return (
    <>
      <GestureDetector gesture={!blocked && !isTabOverview && !isStart && entry?.gesture ? entry.gesture : inertGesture}>
        <MaterialBottomBar
          {...bar}
          container={{
            ...container,
            testID: "materialBottomBar",
            pointerEvents: blocked ? "none" : "auto",
            importantForAccessibility: blocked ? "no-hide-descendants" : "auto",
            accessibilityElementsHidden: Boolean(blocked),
            style: barStyles,
          }}
        />
      </GestureDetector>
      {enabled && surface === "browsing" && matches && page?.siteSettingsSheet ? (
        <View testID="siteSettingsLayer" pointerEvents="box-none" style={styles.siteSettingsLayer}>
          {page.siteSettingsSheet}
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  place: { position: "absolute" },
  hidden: { opacity: 0, elevation: 0 },
  siteSettingsLayer: { ...StyleSheet.absoluteFill, elevation: 4, zIndex: 1 },
});
