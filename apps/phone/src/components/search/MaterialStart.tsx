import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { newIncognitoTab, newRegularTab, newTab, openArchive, openSpaces, reopenLastClosed, showDeck } from "../../state/browse/store";
import { useSearchOpen } from "../../state/search/hooks";
import { openSettings } from "../../state/settings/hooks";
import { useSyncEnabled } from "../../state/sync/hooks";
import { useCanReopen, useHasTabs, useIncognito } from "../../state/tabs/hooks";
import { ArdiaLogo, Backdrop, browseLayout, Symbol, useReduceMotion, useTheme, type SymbolName } from "../ui";
import { useMaterialRipple } from "../ui/MaterialSurfaces";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialDuration, materialMotion, materialMove, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { reducedMotionMs } from "../ui/motion";

const FIELD_EDGE = 16;

export const materialStartMs = (reduceMotion: boolean, searching: boolean) =>
  reduceMotion ? reducedMotionMs(materialDuration.short3) : searching ? materialMotion.fadeThroughOut.durationMs : materialMotion.fadeThroughIn.durationMs;

export function MaterialStart() {
  const { scheme } = useMaterialTheme();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const searching = useSearchOpen();
  const hasTabs = useHasTabs();
  const incognito = useIncognito();
  const canReopen = useCanReopen();
  const syncs = useSyncEnabled();
  const reduceMotion = useReduceMotion();
  const field = useMaterialRipple();
  const shown = useSharedValue(searching ? 0 : 1);
  useEffect(() => {
    shown.value = materialMove(searching ? 0 : 1, searching ? materialMotion.fadeThroughOut.easing : materialMotion.fadeThroughIn.easing, materialStartMs(reduceMotion, searching));
  }, [searching, reduceMotion]);
  const fade = useAnimatedStyle(() => ({ opacity: shown.value }));
  const ink = incognito ? scheme.inverseOnSurface : scheme.onSurface;
  const inkVariant = incognito ? scheme.inverseOnSurface : scheme.onSurfaceVariant;
  const leading: { icon: SymbolName; label: string; onPress: () => void } = hasTabs
    ? { icon: "squareOnSquare", label: "Tabs", onPress: showDeck }
    : syncs
      ? { icon: "laptop", label: "Synced Tabs", onPress: openSpaces }
      : { icon: "archivebox", label: "Archive", onPress: openArchive };
  return (
    <View testID="materialStart" style={StyleSheet.absoluteFill}>
      {incognito ? <View testID="materialStartBackdrop" style={[StyleSheet.absoluteFill, { backgroundColor: scheme.inverseSurface }]} /> : <Backdrop colors={theme.start.colors} />}
      <Animated.View
        testID="materialStartTopBar"
        pointerEvents={searching ? "none" : "box-none"}
        collapsable={false}
        importantForAccessibility={searching ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={searching}
        style={[styles.topBar, { paddingTop: insets.top, paddingLeft: insets.left + 4, paddingRight: insets.right + 4 }, fade]}
      >
        <StartIconButton icon={leading.icon} label={leading.label} ink={inkVariant} onPress={leading.onPress} />
        <View style={styles.fill} />
        {incognito ? (
          <StartIconButton icon="plus" label="New Tab" ink={inkVariant} onPress={newRegularTab} />
        ) : (
          <StartIconButton icon="eyeglasses" label="New Incognito Tab" ink={inkVariant} onPress={newIncognitoTab} />
        )}
        {canReopen && !incognito ? <StartIconButton icon="arrowUturnBackward" label="Reopen Closed Tab" ink={inkVariant} onPress={reopenLastClosed} /> : null}
        <StartIconButton icon="gearshape" label="Settings" ink={inkVariant} onPress={() => openSettings()} />
      </Animated.View>
      <Animated.View style={[styles.logo, fade]} pointerEvents="none" importantForAccessibility={searching ? "no-hide-descendants" : "auto"} accessibilityElementsHidden={searching}>
        <ArdiaLogo width={browseLayout.logoWidth} />
        {incognito ? <Text style={[materialType.titleMedium, { color: ink }]}>You’re browsing Incognito</Text> : null}
      </Animated.View>
      <Animated.View
        testID="materialStartBottom"
        pointerEvents={searching ? "none" : "box-none"}
        collapsable={false}
        importantForAccessibility={searching ? "no-hide-descendants" : "auto"}
        accessibilityElementsHidden={searching}
        style={[styles.bottom, { bottom: insets.bottom + FIELD_EDGE, left: insets.left + FIELD_EDGE, right: insets.right + FIELD_EDGE }, fade]}
      >
        <Pressable
          testID="materialStartSearch"
          accessibilityRole="button"
          accessibilityLabel={incognito ? "New Incognito Tab" : "New Tab"}
          accessibilityHint="Opens search."
          android_ripple={field}
          onPress={newTab}
          style={[styles.field, { backgroundColor: incognito ? scheme.surfaceContainerHighest : scheme.surfaceContainerHigh }]}
        >
          <Symbol name="magnifyingglass" size={materialSize.icon} color={scheme.onSurfaceVariant} />
          <Text numberOfLines={1} style={[materialType.bodyLarge, styles.fill, { color: scheme.onSurfaceVariant }]}>
            Search or type address
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function StartIconButton({ icon, label, ink, onPress }: { icon: SymbolName; label: string; ink: string; onPress: () => void }) {
  const ripple = useMaterialRipple(true);
  return (
    <Pressable testID={`materialStart:${label}`} accessibilityRole="button" accessibilityLabel={label} android_ripple={ripple} onPress={onPress} style={styles.iconButton}>
      <Symbol name={icon} size={materialSize.icon} color={ink} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  topBar: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", minHeight: materialSize.topAppBar, gap: 4 },
  iconButton: { width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center", borderRadius: materialShape.full },
  logo: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", gap: 16 },
  bottom: { position: "absolute" },
  field: { height: materialSize.searchBar, borderRadius: materialShape.full, overflow: "hidden", flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 16 },
});
