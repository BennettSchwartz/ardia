import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { countRender } from "../../state/app/interactionPerf";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BAR_SHOWN, barShown, bottomBarCollapses, followScroll, obscuredBottom, pageInsets } from "../../lib/barCollapse";
import type { Design } from "../../lib/design";
import { neighbours, PAGER } from "../../lib/pagerPhysics";
import { useSystemBars } from "../../state/app/systemBars";
import { useFrozenOrder, useNavigation, usePageTone, watchPageLoad } from "../../state/browse/hooks";
import { closePageMenu, editPageQuery, openPageMenu, openSiteSettingsSheet } from "../../state/page/actions";
import { useFindOpen, useMenuDocked, useMenuOpen, usePressOpen, useReaderTabId } from "../../state/page/hooks";
import { captureCurrentCover, newTab, pageLaidOut, showDeck, swipeOrder, switchToNeighbour } from "../../state/browse/store";
import { useSearchFromDockedMenu, useSearchOpen } from "../../state/search/hooks";
import { usePages } from "../../state/pages/store";
import { reportBarPill } from "../../state/search/stageBar";
import { searchStageIsNative } from "../../platform/searchStage";
import { usePreferences } from "../../state/settings/hooks";
import { closeFrontTab, menuOpenedHaptic, recentTabs, switchToTab, tabTitle } from "../../state/browse/tabMenus";
import { useDeckOrder, useIncognito } from "../../state/tabs/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { countUsage } from "../../state/telemetry/telemetry";
import {
  barCenterFromBottom,
  barHeight,
  browseLayout,
  ink,
  isDarkColor,
  LoadingLine,
  type LoadWatch,
  Menu,
  Shade,
  rolesFor,
  space,
  tabsInk,
  tabsLayout,
  tabsMotion,
  floatingBarLayout,
  useDesign,
  usePageUnderBars,
  usePresence,
  useTheme,
  type MenuItem,
  useReduceMotion,
} from "../ui";
import { BottomBar } from "./BottomBar";
import { FloatingBar } from "./FloatingBar";
import { MaterialBarBand } from "./MaterialPageBar";
import { useMaterialBarRegistration } from "./PersistentMaterialBar";
import { useMaterialTheme } from "../ui/materialTheme";
import { HostPill, useBarFold } from "./HostPill";
import { hostPillLayout } from "./hostPillTokens";
import { FindBar } from "./FindBar";
import { MaterialFindBar } from "./MaterialFindBar";
import { PageMenu } from "./PageMenu";
import { PageRequestHost, PressMenu } from "./PageRequests";
import { ReaderView } from "./ReaderView";
import { PageFailureView } from "./PageFailureView";
import { PageCover } from "./PageCover";
import { PageSurface } from "./PageSurface";
import { useDemoMotion } from "./DemoMotion";
import { PagerBackdrop, PagerNeighbour, useTabPager } from "./TabPager";
import { launchArguments } from "../../state/app/launchFlags";
import { columnContentWidth, SCREEN_COLUMN, type ScreenColumn } from "../../state/app/screenLayout";
import { BrowsingColumn } from "../column/BrowsingColumn";
import { columnMenuPlace, columnPadding, useColumn } from "../column/SideColumn";
import { shownTone } from "../../lib/pageTone";

export const BrowsingScreen = memo(function BrowsingScreen({ tab }: { tab: BrowserTab }) {
  countRender("BrowsingScreen");
  const theme = useTheme();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const safeSide = Math.max(insets.left, insets.right);
  const column = useColumn();
  const pageWidth = column ? columnContentWidth(column, width) : width;
  const menuOpen = useMenuOpen();
  const menuDocked = useMenuDocked();
  const finding = useFindOpen();
  const readerId = useReaderTabId();
  const pressing = usePressOpen();
  const tone = usePageTone(tab.id);
  const order = useDeckOrder();
  const frozen = useFrozenOrder();
  const searching = useSearchOpen();
  const searchFromMenu = useSearchFromDockedMenu();
  const dockedSearch = design === "material" && menuDocked && searching && searchFromMenu;
  const [tabsMenu, setTabsMenu] = useState(false);
  const menu = usePresence(menuOpen || dockedSearch);
  useEffect(() => closePageMenu, [tab.id]);
  const byId = useMemo(() => new Map(order.map((t) => [t.id, t])), [order]);
  const around = useMemo(() => neighbours(swipeOrder(), tab.id), [order, frozen, tab.id]);
  const left = around.left ? (byId.get(around.left) ?? null) : null;
  const right = around.right ? (byId.get(around.right) ?? null) : null;
  const pager = useTabPager({
    width: pageWidth,
    selectedId: tab.id,
    left: left?.id ?? null,
    right: right?.id ?? null,
    onCommit: switchToNeighbour,
    onGrab: captureCurrentCover,
  });
  useDemoMotion(pager, pageWidth);
  const failed = useNavigation(tab.id, (n) => n?.failure != null);
  const pageTone = failed ? null : shownTone(tone, tab.themeColorHex);
  const top = pageTone?.top ?? theme.surface;
  const bottom = pageTone?.bottom ?? theme.surface;
  const barDark = (design === "redesigned" || design === "material") && !pageTone?.bottom ? theme.dark : isDarkColor(bottom);
  useSystemBars(isDarkColor(top), barDark);
  const barSlotHeight = barHeight(insets.bottom, design);
  const collapse = useBarCollapse(tab.id, finding, design, barSlotHeight);
  const staged = design === "redesigned" && !column && searchStageIsNative();
  useEffect(() => (staged && !collapse.hidden ? reportBarPill() : undefined), [staged, collapse.hidden]);
  const underBar = usePageUnderBars();
  const layout = column ? COLUMN_PAGE : underBar ? { pageBottom: 0, toneBottom: design === "material" ? 0 : barSlotHeight } : pageInsets(collapse.collapses, barSlotHeight, browseLayout.pageOverlap);
  const fullscreen = usePages((s) => s.fullscreen[tab.id] ?? false);
  const coveredBottom = design === "material" ? 0 : obscuredBottom({ follows: Platform.OS === "android", bar: barSlotHeight, pill: barCenterFromBottom(insets.bottom, design) - floatingBarLayout.control / 2 + hostPillLayout.height, collapsed: collapse.collapsed, cleared: fullscreen || finding || searching });
  const obscured = column ? COLUMN_OBSCURED : underBar ? { top: insets.top, bottom: coveredBottom } : undefined;
  const painted = useSharedValue(false);
  useEffect(() => {
    painted.value = true;
  }, [painted]);
  const openTabsMenu = () => {
    menuOpenedHaptic();
    setTabsMenu(true);
  };
  const stepTab = (delta: -1 | 1) => {
    const id = delta < 0 ? left?.id : right?.id;
    if (id) switchToNeighbour(id);
  };
  const incognito = useIncognito();
  const swipesUp = !column && !searching && !collapse.hidden;
  const openDeckFromBar = () => {
    if (!incognito) countUsage("deck_bar_swipes");
    void showDeck();
  };
  const barGesture = useMemo(() => Gesture.Race(pager.gesture, barSwipeUp(swipesUp, pager.active, openDeckFromBar)), [pager.gesture, swipesUp, incognito]);
  const statusStyle = useAnimatedStyle(() => ({ backgroundColor: painted.value ? withTiming(top, { duration: tabsMotion.barTone }) : top }), [top]);
  const barStyle = useAnimatedStyle(() => ({ backgroundColor: painted.value ? withTiming(bottom, { duration: tabsMotion.barTone }) : bottom }), [bottom]);
  const { scheme: materialScheme } = useMaterialTheme(tab.isPrivate);
  const pageMenu = menu.mounted ? <PageMenu tabId={tab.id} open={menuOpen} onHidden={menu.hidden} /> : null;
  const siteSettingsSheet = design === "material" && menuDocked ? pageMenu : null;
  const barBlocked = collapse.hidden || siteSettingsSheet !== null;
  const materialBarHosted = useMaterialBarRegistration("page", design === "material" && !column ? {
    bar: { isTabOverview: false, scheme: materialScheme, tab, order, showsPlus: !searching, addressDocked: siteSettingsSheet !== null, onTabs: showDeck, onTabsMenu: openTabsMenu, onStep: stepTab, onAddress: editPageQuery, onPlus: newTab, onMore: openPageMenu, onSiteSettings: openSiteSettingsSheet },
    gesture: barGesture,
    tabId: tab.id,
    hidden: finding || fullscreen || (menu.mounted && !siteSettingsSheet) || readerId === tab.id || pressing || tabsMenu,
    blocked: barBlocked,
    collapse: { progress: collapse.hide, travel: collapse.travel },
    siteSettingsSheet,
  } : null);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: column ? (theme.dark ? ink.black : ink.white) : theme.surface }]} onLayout={() => pageLaidOut(tab.id)}>
      <Shade shaded={menuOpen || dockedSearch || readerId === tab.id || pressing || tabsMenu}>
        <PageStack column={column}>
        <PagerBackdrop />
        <Animated.View style={[StyleSheet.absoluteFill, styles.outgoing, { backgroundColor: theme.surface }, pager.outgoing]}>
          {underBar ? null : <Animated.View testID="pageStatusStrip" style={[{ height: insets.top }, statusStyle]} />}
          <View testID="pageArea" style={[styles.page, { marginBottom: layout.pageBottom }]}>
            <PageSurface key={tab.id} tab={tab} toneBottom={layout.toneBottom} obscured={obscured} />
            <PageCover key={`${tab.id}:cover`} tab={tab} />
            <PageFailureView key={`${tab.id}:failure`} tabId={tab.id} />
          </View>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: tabsInk.pagerBlack }, pager.dim]} pointerEvents="none" />
        </Animated.View>
        {left ? <PagerNeighbour pager={pager} tab={left} side={-1} width={pageWidth} statusHeight={insets.top} hasLeft hasRight={right !== null} /> : null}
        {right ? <PagerNeighbour pager={pager} tab={right} side={1} width={pageWidth} statusHeight={insets.top} hasLeft={left !== null} hasRight /> : null}
        <View style={[styles.loading, { top: insets.top }]} pointerEvents="none">
          <PageLoadingLine tabId={tab.id} color={theme.accent} />
        </View>
        </PageStack>
        {column ? (
          <BrowsingColumn
            column={column}
            width={width}
            tab={tab}
            order={order}
            roles={rolesFor(theme.dark)}
            dark={theme.dark}
            hidden={finding}
            onTabs={showDeck}
            onTabsMenu={openTabsMenu}
            onStep={stepTab}
            onAddress={editPageQuery}
            onPlus={newTab}
            onMore={openPageMenu}
          />
        ) : materialBarHosted && design === "material" ? null : (
          <GestureDetector gesture={barGesture}>
            <Animated.View
              testID="pageBar"
              pointerEvents={barBlocked ? "none" : design === "redesigned" || design === "material" ? "box-none" : "auto"} collapsable={false}
              importantForAccessibility={barBlocked ? "no-hide-descendants" : "auto"}
              accessibilityElementsHidden={barBlocked}
              style={[styles.bar, { height: barHeight(insets.bottom, design) }, underBar ? null : barStyle, finding && design === "material" ? styles.replacedBar : collapse.style]}
            >
              {design === "redesigned" ? (
                <View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, design) - floatingBarLayout.control / 2, paddingHorizontal: safeSide }]} pointerEvents="box-none">
                  <Animated.View
                    testID="floatingBarFold"
                    collapsable={false}
                    style={collapse.fold.bar}
                    pointerEvents={collapse.collapsed ? "none" : "box-none"}
                    importantForAccessibility={collapse.collapsed ? "no-hide-descendants" : "auto"}
                    accessibilityElementsHidden={collapse.collapsed}
                  >
                    <FloatingBar
                      tab={tab}
                      order={order}
                      roles={rolesFor(barDark)}
                      dark={barDark}
                      showsPlus={staged || !searching}
                      anchors={!collapse.collapsed}
                      onTabs={showDeck}
                      onTabsMenu={openTabsMenu}
                      onStep={stepTab}
                      onAddress={editPageQuery}
                      onPlus={newTab}
                      onMore={openPageMenu}
                    />
                  </Animated.View>
                  {collapse.fold.pillMounted ? (
                    <Animated.View
                      testID="hostPillFold"
                    collapsable={false}
                      style={[styles.pillPlace, collapse.fold.pill]}
                      pointerEvents={collapse.collapsed ? "box-none" : "none"}
                      importantForAccessibility={collapse.collapsed ? "auto" : "no-hide-descendants"}
                      accessibilityElementsHidden={!collapse.collapsed}
                    >
                      <HostPill tab={tab} dark={barDark} shown={collapse.collapsed} anchors={collapse.collapsed} contentStyle={collapse.fold.pillContent} onExpand={collapse.expand} />
                    </Animated.View>
                  ) : null}
                </View>
              ) : design === "material" ? (
                <MaterialBarBand tab={tab} order={order} showsPlus={!searching} addressDocked={siteSettingsSheet !== null} safeSide={safeSide} onTabs={showDeck} onTabsMenu={openTabsMenu} onStep={stepTab} onAddress={editPageQuery} onPlus={newTab} onMore={openPageMenu} onSiteSettings={openSiteSettingsSheet} />
              ) : (
                <>
                  <View style={[StyleSheet.absoluteFill, { backgroundColor: barDark ? tabsInk.barShadeOnDark : tabsInk.barShadeOnLight }]} />
                  <View style={[styles.controls, { bottom: barCenterFromBottom(insets.bottom, design) - browseLayout.hitTarget / 2, paddingHorizontal: safeSide }]}>
                    <BottomBar order={order} roles={rolesFor(barDark)} showsPlus={!searching} onTabs={showDeck} onTabsMenu={openTabsMenu} onStep={stepTab} onPlus={newTab} onMore={openPageMenu} />
                  </View>
                </>
              )}
            </Animated.View>
          </GestureDetector>
        )}
        {finding && (design !== "material" || column) ? <FindBar tabId={tab.id} /> : null}
      </Shade>
      {finding && design === "material" && !column ? <MaterialFindBar tabId={tab.id} /> : null}
      {tabsMenu ? (
        <Menu
          items={tabsMenuItems(order)}
          place={column ? { ...columnMenuPlace(column, width, SCREEN_COLUMN.top), width: Math.min(tabsLayout.menuWidth, pageWidth - space.l * 2) } : { bottom: barHeight(insets.bottom, design) + space.xs, left: space.l, width: Math.min(tabsLayout.menuWidth, width - space.l * 2) }}
          onDismiss={() => setTabsMenu(false)}
        />
      ) : null}
      <PressMenu width={width} height={height} />
      {materialBarHosted && siteSettingsSheet ? null : pageMenu}
      {readerId === tab.id ? <ReaderView tabId={tab.id} /> : null}
      <PageRequestHost tabId={tab.id} />
    </View>
  );
});

const COLUMN_PAGE = { pageBottom: 0, toneBottom: 0 };
const COLUMN_OBSCURED = { top: 0, bottom: 0 };

function PageStack({ column, children }: { column: ScreenColumn | null; children: ReactNode }) {
  if (!column) return children;
  return (
    <View testID="columnPageStack" style={[styles.columnPage, columnPadding(column)]}>
      {children}
    </View>
  );
}

function useBarCollapse(tabId: string, finding: boolean, design: Design, height: number) {
  const folds = design === "redesigned";
  const collapses = bottomBarCollapses(design, usePreferences((p) => p.collapsesBottomBar));
  const materialFind = design === "material" && finding;
  const direction = useNavigation(tabId, (n) => n?.scrollDirection ?? "up");
  const page = useNavigation(tabId, (n) => n?.url ?? null);
  const reduceMotion = useReduceMotion();
  const followsScroll = collapses && !materialFind;
  const [state, setState] = useState(() => followScroll(BAR_SHOWN, tabId, page, direction, followsScroll));
  useEffect(() => setState((now) => followScroll(now, tabId, page, direction, followsScroll)), [tabId, page, direction, followsScroll]);
  const scrolledAway = state.hidden && state.tabId === tabId;
  const collapsed = folds && scrolledAway && !finding;
  const hidden = finding || (!folds && scrolledAway);
  const slidesAway = hidden && !materialFind;
  const fold = useBarFold(collapsed, reduceMotion);
  const hide = useSharedValue(0);
  useEffect(() => {
    hide.value = reduceMotion ? withTiming(slidesAway ? 1 : 0, { duration: tabsMotion.barCollapseReduced }) : withSpring(slidesAway ? 1 : 0, tabsMotion.barCollapse);
  }, [slidesAway, reduceMotion]);
  const travel = design === "material" ? height : browseLayout.barCollapseTravel;
  const style = useAnimatedStyle(() => ({ opacity: 1 - hide.value, transform: [{ translateY: hide.value * travel }] }), [travel]);
  const expand = () => setState(barShown);
  return { collapses, hidden, collapsed, fold, expand, style, hide, travel };
}

function tabsMenuItems(order: BrowserTab[]): MenuItem[] {
  const others = recentTabs(order).map((tab): MenuItem => ({ label: tabTitle(tab), onPress: () => switchToTab(tab.id) }));
  return [...others, ...(others.length ? ["divider" as const] : []), { label: "Close Tab", icon: "xmark", destructive: true, onPress: closeFrontTab }];
}

export function barSwipeUp(enabled: boolean, pagerActive: { value: number }, open: () => void) {
  return Gesture.Pan()
    .withTestId("barSwipeUp")
    .enabled(enabled)
    .activeOffsetY(-browseLayout.barSwipeUp)
    .failOffsetY(PAGER.minimumDistance)
    .failOffsetX([-PAGER.minimumDistance, PAGER.minimumDistance])
    .onStart(() => {
      if (pagerActive.value) return;
      runOnJS(open)();
    });
}

function PageLoadingLine({ tabId, color }: { tabId: string; color: string }) {
  const watch = useMemo<LoadWatch>(() => {
    const loadFreeze = launchArguments().loadFreeze;
    if (loadFreeze !== null) return (show) => (show(loadFreeze, true), () => undefined);
    return (show) => watchPageLoad(tabId, show);
  }, [tabId]);
  return <LoadingLine watch={watch} color={color} />;
}


const styles = StyleSheet.create({
  outgoing: { overflow: "hidden" },
  page: { flex: 1 },
  loading: { position: "absolute", left: 0, right: 0 },
  columnPage: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, overflow: "hidden" },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0 },
  replacedBar: { opacity: 0 },
  controls: { position: "absolute", left: 0, right: 0 },
  pillPlace: { position: "absolute", left: 0, right: 0, bottom: 0, height: hostPillLayout.height, alignItems: "center", justifyContent: "flex-end" },
});
