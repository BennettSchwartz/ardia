import { startTransition, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { FrameProbe } from "./components/perf/FrameProbe";
import { countRender, interactionPerfEnabled } from "./state/app/interactionPerf";
import { AppState, BackHandler, Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BrowsingScreen } from "./components/browsing/BrowsingScreen";
import { MaterialBarProvider, PersistentMaterialBar } from "./components/browsing/PersistentMaterialBar";
import { SearchTray } from "./components/search/SearchTray";
import { StartScreen } from "./components/search/StartScreen";
import { ArchiveView } from "./components/tabs/ArchiveView";
import { TabDeck } from "./components/tabs/TabDeck";
import { OnboardingView } from "./components/onboarding/OnboardingView";
import { ImportFailedView } from "./components/upgrade/ImportFailedView";
import { ExpoSettingsSheet } from "./components/settings/ExpoSettingsStack";
import { ExpoArchiveSheet } from "./components/tabs/ExpoArchive";
import { ExpoSpacesSheet } from "./components/sync/ExpoSpaces";
import { ExpoLibrarySheet } from "./components/library/ExpoLibrary";
import { MaterialLibrary } from "./components/library/MaterialLibrary";
import { useLibrary } from "./state/library/store";
import { MaterialSettingsScreen, SettingsView } from "./components/settings/SettingsView";
import { SpacesView } from "./components/sync/SpacesView";
import { ToastHost } from "./components/toasts/ToastHost";
import { appDesign, tabsMotion, useDesign, useTheme, DEFAULT_PROFILE_COLOR, FrostSource, FullSheet, OverlayHost, PROFILE_PRESETS, onNativeMenuOpened, ProfileLookContext, Shade, SheetBackground, SURFACES_FROST } from "./components/ui";
import { useLook } from "./state/sync/hooks";
import { startSettingsSources } from "./state/settings/actions";
import { startSync } from "./state/sync/actions";
import { setSpacesDesign } from "./state/sync/store";
import { setAppearanceDesign, useDarkScheme } from "./state/settings/appearance";
import { useSettingsNav } from "./state/settings/hooks";
import { offerSyncPages } from "./state/settings/nav";
import { useOnboarding } from "./state/onboarding/hooks";
import { bootApp, useBoot } from "./state/app/boot";
import { startLinks } from "./state/links/links";
import { useBaseSystemBars, useSystemBars } from "./state/app/systemBars";
import { useSearchFromDockedMenu, useSearchOpen } from "./state/search/hooks";
import { useLeavingTab, useOpeningTab, useSheet, useSurface } from "./state/browse/hooks";
import { appBecameActive, appWillResignActive, closeArchive, goBackToStartIfEmpty, startBrowser, type Surface } from "./state/browse/store";
import { refreshHiddenDeck } from "./state/browse/deckHold";
import { noteScreenLayoutName, noteWindowShape } from "./state/app/landscapeCount";
import { DUO_CANVAS, reportScreenLayout, useScreenLayout } from "./state/app/screenLayout";
import { DuoBrowsing } from "./components/duo/DuoBrowsing";
import { ScreenLayoutProbe } from "@ardia/phone-native";
import { handleSystemBack, startPageUi } from "./state/page/actions";
import { VoiceSearchView } from "./components/search/VoiceSearchView";
import { useVoicePresented } from "./state/voice/store";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { closeSettings } from "./state/settings/nav";
import { applyLaunchSettings, runLaunchScenario } from "./state/app/launch";
import { frontSheet } from "./state/settings/settingsRules";
import { inkLayer, lightStatusIcons } from "./lib/statusInk";
import { countUsage, reportLaunch, startTelemetry } from "./state/telemetry/telemetry";
import { useIncognito, useSelectedTab } from "./state/tabs/hooks";
import { setRootSize } from "./state/app/rootSize";
import { syncOffered } from "./state/sync/offer";
import { followDynamicScheme } from "./state/app/dynamicScheme";
import { onMaterialBackSwiped } from "./components/ui/MaterialSurfaces";
import { useTabs } from "./state/tabs/store";

export default function App() {
  useState(() =>
    bootApp(() => {
      offerSyncPages(syncOffered);
      setSpacesDesign(appDesign);
      setAppearanceDesign(appDesign);
      if (appDesign === "material") followDynamicScheme();
      startTelemetry();
      startBrowser(applyLaunchSettings);
      startPageUi();
      startSettingsSources();
      if (syncOffered()) startSync();
      startLinks();
      runLaunchScenario();
    }),
  );
  const ready = useBoot((s) => s.ready);
  const importFailed = useBoot((s) => s.failures > 0);
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => void reportLaunch(Date.now()));
    return () => cancelAnimationFrame(frame);
  }, [ready]);
  const dark = useDarkScheme();
  const look = useLook(PROFILE_PRESETS, DEFAULT_PROFILE_COLOR);
  useBaseSystemBars(dark);
  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => useBoot.getState().ready && handleSystemBack());
    const state = AppState.addEventListener("change", (next) => {
      if (!useBoot.getState().ready) return;
      if (next === "active") appBecameActive();
      else appWillResignActive();
    });
    return () => {
      back.remove();
      state.remove();
    };
  }, []);
  return (
    <GestureHandlerRootView style={styles.root} onLayout={(event) => setRootSize(event.nativeEvent.layout.width, event.nativeEvent.layout.height)}>
      <SafeAreaProvider>
        <ScreenLayoutProbe onLayoutChange={reportScreenLayout} />
        <ProfileLookContext.Provider value={look}>
          <OverlayHost>{ready ? <DuoCanvasFrame><Surfaces /></DuoCanvasFrame> : importFailed ? <ImportFailedView /> : null}</OverlayHost>
          {interactionPerfEnabled() ? <FrameProbe /> : null}
        </ProfileLookContext.Provider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const SYSTEM_SHEETS = Platform.OS === "ios";

onNativeMenuOpened(() => countUsage("native_menus_opened"));

onMaterialBackSwiped(() => {
  if (!useTabs.getState().incognito) countUsage("material_back_swiped");
});

export function Surfaces() {
  const surface = useSurface();
  const sheet = useSheet();
  const tab = useSelectedTab();
  const opening = useOpeningTab();
  const leaving = useLeavingTab();
  const pageUnderDeck = surface === "deck" && tab !== null && (tab.id === opening || tab.id === leaving);
  const settingsOpen = useSettingsNav((s) => s.open);
  const onboarding = useOnboarding((s) => s.showing);
  const searching = useSearchOpen();
  const searchFromMenu = useSearchFromDockedMenu();
  const voice = useVoicePresented();
  const sheetProgress = useSharedValue(0);
  const libraryOpen = useLibrary((s) => s.open);
  const material = useDesign() === "material";
  const settingsScreen = material && settingsOpen && !SYSTEM_SHEETS;
  const libraryCovers = material && libraryOpen;
  const systemSheet = SYSTEM_SHEETS && (settingsOpen || libraryOpen || sheet === "archive" || sheet === "spaces");
  const front = settingsScreen ? null : frontSheet(settingsOpen && !SYSTEM_SHEETS, SYSTEM_SHEETS ? null : sheet);
  const sheetCovers = front !== null || systemSheet || settingsScreen;
  const theme = useTheme();
  countRender("Surfaces");
  const incognito = useIncognito();
  const layer = inkLayer({ onboarding, voice, sheet: sheetCovers, searching: searching || libraryCovers, surface });
  const lightIcons = settingsScreen && layer === "sheet" ? theme.dark : lightStatusIcons(layer, { cover: theme.backdrop[0], surface: theme.surface, deck: theme.backdrop[0], incognito: incognito && !libraryCovers });
  useEffect(goBackToStartIfEmpty, [tab, surface]);
  const duo = useScreenLayout((s) => s.layout.name === "wide" || s.layout.name === "split");
  const deckMounted = useDeckStandby(surface, surface === "browsing" && tab !== null && opening === null && leaving === null && !searching && !voice && !onboarding && front === null && !settingsScreen, tab?.id ?? null);
  const deckCoversPage = useSharedValue(0);
  useLayoutEffect(() => {
    if (surface !== "deck") deckCoversPage.value = 0;
  }, [surface]);
  const pageUnderDeckStyle = useAnimatedStyle(() => ({ opacity: deckCoversPage.value ? 0 : 1 }));
  return (
    <MaterialBarProvider enabled={material && !duo}>
      <LandscapeCount />
      <SheetBackground progress={sheetProgress}>
        <Layer covered={onboarding || voice} muted={sheetCovers || libraryCovers}>
          <Shade shaded={searching && !(material && searchFromMenu)}>
            <FrostSource name={SURFACES_FROST} style={StyleSheet.absoluteFill} pointerEvents="box-none" collapsable={false}>
              {duo && surface !== "start" ? <DuoBrowsing /> : null}
              {!duo && (surface === "browsing" || pageUnderDeck) && tab ? (
                <Animated.View style={[StyleSheet.absoluteFill, pageUnderDeckStyle]} pointerEvents={surface === "browsing" ? "box-none" : "none"}>
                  <BrowsingScreen tab={tab} />
                </Animated.View>
              ) : null}
              {!duo && deckMounted ? <TabDeck coversPage={deckCoversPage} /> : null}
              {surface === "start" ? <StartScreen /> : null}
              {material ? <PersistentMaterialBar /> : null}
            </FrostSource>
          </Shade>
          <SearchTray />
        </Layer>
      </SheetBackground>
      <Layer covered={onboarding || voice}>
        <FullSheet sheet={front} progress={sheetProgress} onDismiss={front === "settings" ? closeSettings : closeArchive}>
          {(shown) => (shown === "settings" ? <SettingsView /> : shown === "archive" ? <ArchiveView /> : <SpacesView />)}
        </FullSheet>
        {settingsScreen ? <MaterialSettingsScreen /> : null}
      </Layer>
      {SYSTEM_SHEETS ? <ExpoSettingsSheet /> : null}
      {SYSTEM_SHEETS ? <ExpoArchiveSheet /> : null}
      {SYSTEM_SHEETS ? <ExpoSpacesSheet /> : null}
      {SYSTEM_SHEETS ? <ExpoLibrarySheet /> : null}
      {material ? <MaterialLibrary /> : null}
      <Layer covered={onboarding}>
        <VoiceSearchView />
      </Layer>
      <OnboardingView />
      <ToastHost />
      {lightIcons !== null ? <LayerInk key={layer} light={lightIcons} /> : null}
    </MaterialBarProvider>
  );
}

function DuoCanvasFrame({ children }: { children: ReactNode }) {
  const canvas = useScreenLayout((s) => s.canvas);
  if (!canvas) return <>{children}</>;
  return (
    <View testID="duoCanvas" style={styles.canvasBack}>
      <View style={[styles.canvas, { width: canvas.width, height: canvas.height }]}>{children}</View>
    </View>
  );
}

function LandscapeCount() {
  const { width, height } = useWindowDimensions();
  const layout = useScreenLayout((s) => s.layout.name);
  useEffect(() => noteWindowShape(width, height), [width, height]);
  useEffect(() => noteScreenLayoutName(layout), [layout]);
  return null;
}

function useDeckStandby(surface: Surface, pageSettled: boolean, pageId: string | null) {
  const [standby, setStandby] = useState(false);
  if (surface === "deck" && !standby) setStandby(true);
  if (surface === "start" && standby) setStandby(false);
  useEffect(() => {
    if (!pageSettled) return;
    const settle = setTimeout(() => (standby ? refreshHiddenDeck() : startTransition(() => setStandby(true))), tabsMotion.deckStandby);
    return () => clearTimeout(settle);
  }, [pageSettled, pageId, standby]);
  return surface !== "start" && (standby || surface === "deck");
}

function LayerInk({ light }: { light: boolean }) {
  useSystemBars(light);
  return null;
}

const COVER_SETTLE_MS = 450;

function Layer({ covered, muted = false, children }: { covered: boolean; muted?: boolean; children: ReactNode }) {
  const [gone, setGone] = useState(covered);
  useEffect(() => {
    if (!covered) {
      setGone(false);
      return;
    }
    const settle = setTimeout(() => setGone(true), COVER_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [covered]);
  return (
    <View
      style={[StyleSheet.absoluteFill, gone ? styles.gone : null]}
      pointerEvents={covered || muted ? "none" : "box-none"}
      collapsable={false}
      importantForAccessibility={covered || muted ? "no-hide-descendants" : "auto"}
      accessibilityElementsHidden={covered || muted}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  gone: { display: "none" },
  canvasBack: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#000000", alignItems: "center", justifyContent: "center" },
  canvas: { borderRadius: DUO_CANVAS.radius, borderCurve: "continuous", overflow: "hidden" },
});
