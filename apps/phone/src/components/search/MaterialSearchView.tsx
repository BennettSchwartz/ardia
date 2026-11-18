import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { activateRow, cancelSearch, submitSearch, toggleTrayIncognito } from "../../state/browse/store";
import { menuOpenedHaptic, trayRowActions } from "../../state/browse/tabMenus";
import { useSearchFieldVersion, useSearchInitialText, useSearchOpen, useSearchRows, useSearchSession, useSearchText } from "../../state/search/hooks";
import { refinedText, type TrayRow } from "../../state/search/omnibox";
import { searchState, setSearchText, typeSearch } from "../../state/search/store";
import { useIncognito } from "../../state/tabs/hooks";
import { canSearchByVoice, presentVoiceSearch, useVoice } from "../../state/voice/store";
import { predictiveBack } from "@ardia/phone-native";
import { countUsage } from "../../state/telemetry/telemetry";
import { useTabs } from "../../state/tabs/store";
import { useTrayCovers } from "../../state/search/trayBack";
import { FloatingMenu, Symbol, useTheme } from "../ui";
import { useReduceMotion } from "../ui/contrast";
import { backSwipe, useMaterialRipple } from "../ui/MaterialSurfaces";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialDuration, materialMotion, materialMove, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { reducedMotionMs } from "../ui/motion";
import { SuggestionRow } from "./SuggestionRow";
import { TrayInput, type TrayInputHandle } from "./TrayInput";

const HEADER_HEIGHT = 72;

export const materialSearchMs = (reduceMotion: boolean, entering: boolean) =>
  reduceMotion ? reducedMotionMs(materialDuration.short3) : entering ? materialMotion.fadeThroughIn.durationMs : materialMotion.fadeThroughOut.durationMs;

export function MaterialSearchTray() {
  const open = useSearchOpen();
  const session = useSearchSession();
  const [mounted, setMounted] = useState(open ? session : null);
  useEffect(() => {
    if (open) setMounted(session);
  }, [open, session]);
  if (mounted === null) return null;
  return <MaterialSearchView key={mounted} open={open} onGone={() => setMounted(null)} />;
}

function MaterialSearchView({ open, onGone }: { open: boolean; onGone: () => void }) {
  const { scheme } = useMaterialTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const icon = useMaterialRipple(true);
  const incognito = useIncognito();
  const shown = useSharedValue(0);
  const back = useSharedValue(0);
  const version = useSearchFieldVersion();
  const field = useRef<TrayInputHandle | null>(null);
  const voice = useVoice((state) => state.presented);
  const covered = useTrayCovers((state) => state.covers > 0);
  const claimsBack = open && !voice && !covered;
  useEffect(() => {
    if (!claimsBack) return;
    const swipe = backSwipe(() => {
      if (!useTabs.getState().incognito) countUsage("tray_back_swiped");
    });
    const claim = predictiveBack.claim({
      onProgress: (progress) => {
        swipe.progress(progress);
        back.value = progress;
      },
      onCancel: () => {
        swipe.cancel();
        back.value = materialMove(0, "standard", materialDuration.short4);
      },
      onCommit: () => {
        swipe.commit();
        cancelSearch();
      },
    });
    return () => {
      claim.remove();
      back.value = 0;
    };
  }, [claimsBack]);
  useEffect(() => {
    if (open) {
      shown.value = materialMove(1, materialMotion.fadeThroughIn.easing, materialSearchMs(reduceMotion, true));
      return;
    }
    field.current?.blur();
    Keyboard.dismiss();
    const gone = (finished?: boolean) => {
      "worklet";
      if (finished) runOnJS(onGone)();
    };
    shown.value = materialMove(0, materialMotion.fadeThroughOut.easing, materialSearchMs(reduceMotion, false), gone);
  }, [open]);
  const enter = useAnimatedStyle(() => ({ opacity: shown.value, transform: [{ scale: (0.96 + 0.04 * shown.value) * (1 - 0.1 * back.value) }, { translateY: back.value * 24 }], borderRadius: back.value * 28 }));
  const surface = incognito ? scheme.inverseSurface : scheme.surfaceContainerHigh;
  const ink = incognito ? scheme.inverseOnSurface : scheme.onSurface;
  const inkVariant = incognito ? scheme.inverseOnSurface : scheme.onSurfaceVariant;
  return (
    <Animated.View
      testID="materialSearchView"
      accessibilityViewIsModal={open}
      collapsable={false}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      pointerEvents={open ? "auto" : "none"}
      style={[StyleSheet.absoluteFill, { backgroundColor: surface, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }, enter]}>
      <View testID="materialSearchHeader" style={styles.header}>
        <Pressable testID="materialSearchBack" accessibilityRole="button" accessibilityLabel="Close Search" android_ripple={icon} onPress={cancelSearch} style={styles.iconButton}>
          <View style={styles.flipped}>
            <Symbol name="arrowRight" size={materialSize.icon} color={ink} />
          </View>
        </Pressable>
        <MaterialSearchField key={version} first={version === 0} ink={ink} hint={inkVariant} accent={scheme.primary} handle={field} />
        <Pressable
          testID="materialSearchIncognito"
          accessibilityRole="button"
          accessibilityLabel={incognito ? "Deactivate Incognito" : "Activate Incognito"}
          accessibilityState={{ selected: incognito }}
          android_ripple={icon}
          onPress={toggleTrayIncognito}
          style={[styles.iconButton, incognito ? { backgroundColor: scheme.inversePrimary } : null]}
        >
          <Symbol name="eyeglasses" size={materialSize.icon} color={incognito ? scheme.onPrimaryContainer : inkVariant} />
        </Pressable>
      </View>
      <View style={[styles.divider, { backgroundColor: incognito ? scheme.outline : scheme.outlineVariant }]} />
      <MaterialSearchRows incognito={incognito} ink={inkVariant} />
    </Animated.View>
  );
}

function MaterialSearchField({ first, ink, hint, accent, handle }: { first: boolean; ink: string; hint: string; accent: string; handle: React.MutableRefObject<TrayInputHandle | null> }) {
  const icon = useMaterialRipple(true);
  const initialText = useSearchInitialText();
  const incognito = useIncognito();
  const [start] = useState(() => searchState().text);
  const [hasText, setHasText] = useState(start.length > 0);
  const input = useRef<TrayInputHandle | null>(null);
  const submitted = useRef(false);
  useEffect(() => {
    const focus = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(focus);
  }, []);
  return (
    <>
      <TrayInput
        ref={(made) => {
          input.current = made;
          handle.current = made;
        }}
        style={[materialType.bodyLarge, styles.input]}
        start={start}
        selectsStart={first && Boolean(initialText)}
        color={ink}
        placeholderColor={hint}
        accent={accent}
        keyboardAppearance={incognito ? "dark" : "default"}
        onTyped={(text) => {
          if (text.length > 0 !== hasText) setHasText(text.length > 0);
          typeSearch(text);
        }}
        onSubmit={(text) => {
          if (submitted.current) return;
          if (submitSearch(text)) submitted.current = true;
        }}
      />
      {hasText ? (
        <Pressable testID="materialSearchClear" accessibilityRole="button" accessibilityLabel="Clear Text" android_ripple={icon} onPress={() => input.current?.clearsInPlace() || setSearchText("")} style={styles.iconButton}>
          <Symbol name="xmark" size={materialSize.icon} color={hint} />
        </Pressable>
      ) : !incognito && canSearchByVoice() ? (
        <Pressable testID="materialSearchVoice" accessibilityRole="button" accessibilityLabel="Voice Search" android_ripple={icon} onPress={presentVoiceSearch} style={styles.iconButton}>
          <Symbol name="mic" size={materialSize.icon} color={hint} />
        </Pressable>
      ) : null}
    </>
  );
}

function MaterialSearchRows({ incognito, ink }: { incognito: boolean; ink: string }) {
  const theme = useTheme();
  const rows = useSearchRows();
  const typed = useSearchText();
  const [menu, setMenu] = useState<{ row: TrayRow; y: number } | null>(null);
  const refine = useCallback((row: TrayRow) => setSearchText(refinedText(row)), []);
  const showMenu = useCallback((row: TrayRow, y: number) => {
    if (!trayRowActions(row).length) return;
    menuOpenedHaptic();
    setMenu({ row, y });
  }, []);
  if (incognito && !typed.trim())
    return (
      <View testID="materialSearchIncognitoNote" style={styles.note}>
        <Symbol name="eyeglasses" size={materialSize.icon * 2} color={ink} />
        <Text style={[materialType.titleMedium, { color: ink }]}>You’re browsing Incognito</Text>
      </View>
    );
  return (
    <>
      <ScrollView testID="materialSearchRows" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.rows}>
        {rows.map((row, index) => (
          <SuggestionRow key={index} row={row} typed={typed} roles={theme} menu={trayRowActions(row)} onActivate={activateRow} onRefine={refine} onMenu={showMenu} />
        ))}
      </ScrollView>
      {menu ? (
        <FloatingMenu
          items={trayRowActions(menu.row).map((action) => ({ label: action.label, icon: action.icon, onPress: action.run }))}
          place={{ top: menu.y, left: 16 }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  header: { height: HEADER_HEIGHT, flexDirection: "row", alignItems: "center", paddingHorizontal: 4, gap: 4 },
  iconButton: { width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center", borderRadius: materialShape.full, overflow: "hidden" },
  flipped: { transform: [{ scaleX: -1 }] },
  input: { flex: 1, paddingVertical: 0, height: materialSize.touchTarget },
  divider: { height: 1 },
  rows: { paddingVertical: 8 },
  note: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
});
