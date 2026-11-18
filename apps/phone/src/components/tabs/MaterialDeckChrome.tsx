import { useEffect, useRef } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View, type ViewInstance } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import type { MaterialScheme } from "../../lib/material/schemes";
import { haptics } from "../../state/app/haptics";
import { newTab } from "../../state/browse/store";
import { menuOpenedHaptic } from "../../state/browse/tabMenus";
import { useCanReopen } from "../../state/tabs/hooks";
import { noteDeckBarTop, watchDeckBar } from "../../state/toasts/store";
import { Symbol, type MenuItem, type SymbolName } from "../ui";
import { MATERIAL_STATE } from "../ui/materialRoles";
import { materialDuration, materialMove, materialShape, materialSize, materialType } from "../ui/materialTokens";
import { MenuTrigger } from "../ui/MenuTrigger";
import { useKeyboardHeight } from "../search/useKeyboardHeight";
import { plusMenuItems } from "./ChromeButtons";
import { useSearchTabs } from "./DeckBottomBar";
import { deckMoreMenuItems, useDeckSpaces } from "./DeckHeader";
import { MATERIAL_DECK, useDeckScheme } from "./MaterialDeckLayout";

type Menus = { menusShown: boolean; onMenu: (open: boolean) => void };

type ChromeProps = Menus & {
  shown: boolean;
  safeTop: number;
  safeSide: number;
  safeBottom: number;
  deckHeight: number;
  incognito: boolean;
  privateCount: number;
  hasTabs: boolean;
  onQuery: (needle: string) => void;
  onCloseIncognito: () => void;
  onCloseAll: () => void;
};

const ripple = (scheme: MaterialScheme, on: string = scheme.onSurface) => ({ color: withAlpha(on, MATERIAL_STATE.pressed), foreground: true });
const unbounded = (scheme: MaterialScheme) => ({ color: withAlpha(scheme.onSurface, MATERIAL_STATE.pressed), borderless: true, radius: materialSize.iconButton / 2 });

export function MaterialDeckChrome({ shown, safeTop, safeSide, safeBottom, deckHeight, incognito, privateCount, hasTabs, onQuery, onCloseIncognito, onCloseAll, menusShown, onMenu }: ChromeProps) {
  return (
    <>
      <MaterialDeckTopBar safeTop={safeTop} safeSide={safeSide} incognito={incognito} privateCount={privateCount} hasTabs={hasTabs} onCloseIncognito={onCloseIncognito} onCloseAll={onCloseAll} menusShown={menusShown} onMenu={onMenu} />
      <MaterialDeckBottomRow shown={shown} safeSide={safeSide} safeBottom={safeBottom} deckHeight={deckHeight} incognito={incognito} onQuery={onQuery} menusShown={menusShown} onMenu={onMenu} />
    </>
  );
}

export function MaterialDeckBackdrop({ incognito }: { incognito: boolean }) {
  const scheme = useDeckScheme(incognito);
  return <View testID="materialDeckBackdrop" pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: scheme.surface }]} />;
}

type TopBarProps = Menus & { safeTop: number; safeSide: number; incognito: boolean; privateCount: number; hasTabs: boolean; onCloseIncognito: () => void; onCloseAll: () => void };

export function MaterialDeckTopBar({ safeTop, safeSide, incognito, privateCount, hasTabs, onCloseIncognito, onCloseAll, menusShown, onMenu }: TopBarProps) {
  const scheme = useDeckScheme(incognito);
  const canReopen = useCanReopen();
  const { syncEnabled, spaces, current, spaceItems } = useDeckSpaces();
  const side = safeSide + MATERIAL_DECK.barSide;
  const below = safeTop + materialSize.topAppBar;
  const menu = { trigger: "tap" as const, fixedOrder: true, haptic: menuOpenedHaptic, disabled: !menusShown, onOpen: () => onMenu(true), onClose: () => onMenu(false) };
  const moreItems = deckMoreMenuItems({ syncEnabled, canReopen, hasTabs, onCloseAll });
  const incognitoItems: MenuItem[] = [{ label: "Close Incognito Tabs", destructive: true, onPress: onCloseIncognito }];
  const title = current?.name ?? "Tabs";
  return (
    <View testID="materialDeckTopBar" pointerEvents="box-none" style={[styles.topBar, { paddingTop: safeTop, height: safeTop + materialSize.topAppBar, paddingHorizontal: side, backgroundColor: scheme.surface }]}>
      <View style={styles.titleSlot}>
        {current && spaces.length > 1 ? (
          <MenuTrigger items={spaceItems} {...menu} place={{ top: below, left: side + MATERIAL_DECK.titleInset }}>
            {({ onPress }) => (
              <Pressable
                testID="materialDeckSpace"
                accessibilityRole="button"
                accessibilityLabel={`Space, ${current.name}`}
                accessibilityHint="Shows your Mac’s spaces."
                android_ripple={ripple(scheme)}
                onPress={onPress}
                style={styles.spaceButton}
              >
                <Text numberOfLines={1} style={[materialType.titleLarge, styles.shrink, { color: scheme.onSurface }]}>
                  {current.name}
                </Text>
                <Symbol name="chevronDown" size={materialSize.icon} color={scheme.onSurfaceVariant} />
              </Pressable>
            )}
          </MenuTrigger>
        ) : (
          <Text testID="materialDeckTitle" accessibilityRole="header" numberOfLines={1} style={[materialType.titleLarge, styles.title, { color: scheme.onSurface }]}>
            {title}
          </Text>
        )}
      </View>
      {privateCount > 0 ? (
        <MenuTrigger items={incognitoItems} {...menu} place={{ top: below, right: side + materialSize.touchTarget }}>
          {({ onPress }) => <IncognitoChip count={privateCount} onPress={onPress ?? noop} />}
        </MenuTrigger>
      ) : null}
      <MenuTrigger items={moreItems} {...menu} place={{ top: below, right: side }}>
        {({ onPress }) => <MaterialIconButton testID="materialDeckMore" icon="ellipsis" label="More" scheme={scheme} turned onPress={onPress ?? noop} />}
      </MenuTrigger>
    </View>
  );
}

function IncognitoChip({ count, onPress }: { count: number; onPress: () => void }) {
  const dark = useDeckScheme(true);
  return (
    <Pressable
      testID="materialDeckIncognito"
      accessibilityRole="button"
      accessibilityLabel={`Incognito, ${count} ${count === 1 ? "tab" : "tabs"}`}
      accessibilityHint="Shows the option to close incognito tabs."
      android_ripple={ripple(dark)}
      hitSlop={{ top: (materialSize.touchTarget - MATERIAL_DECK.chipHeight) / 2, bottom: (materialSize.touchTarget - MATERIAL_DECK.chipHeight) / 2 }}
      onPressIn={haptics.barPress}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: dark.surfaceContainerHighest }]}
    >
      <Symbol name="eyes" size={MATERIAL_DECK.chipGlyph} color={dark.onSurface} />
      <Text style={[materialType.labelLarge, styles.count, { color: dark.onSurface }]}>{count}</Text>
    </Pressable>
  );
}

export function MaterialIconButton({ testID, icon, label, hint, scheme, turned = false, onPress }: { testID: string; icon: SymbolName; label: string; hint?: string; scheme: MaterialScheme; turned?: boolean; onPress: () => void }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} android_ripple={unbounded(scheme)} onPressIn={haptics.barPress} onPress={onPress} style={styles.iconButton}>
      <View pointerEvents="none" style={turned ? styles.turned : null}>
        <Symbol name={icon} size={materialSize.icon} color={scheme.onSurfaceVariant} />
      </View>
    </Pressable>
  );
}

type BottomProps = Menus & { shown: boolean; safeSide: number; safeBottom: number; deckHeight: number; incognito: boolean; onQuery: (needle: string) => void };

export const materialKeyboardLift = (keyboard: number, safeBottom: number, os: string) => Math.max(0, keyboard + MATERIAL_DECK.keyboardGap - (os === "android" ? 0 : safeBottom) - MATERIAL_DECK.edge);

export function MaterialDeckBottomRow({ shown, safeSide, safeBottom, incognito, onQuery, menusShown, onMenu }: BottomProps) {
  const scheme = useDeckScheme(incognito);
  const canReopen = useCanReopen();
  const search = useSearchTabs(shown, incognito, onQuery);
  const { input, text, focused, change, focus, blur } = search;
  const keyboard = useKeyboardHeight(shown);
  const lift = focused && keyboard > 0 ? materialKeyboardLift(keyboard, safeBottom, Platform.OS) : 0;
  const rise = useSharedValue(0);
  useEffect(() => {
    rise.value = materialMove(-lift, "emphasized", materialDuration.medium2);
  }, [lift]);
  const riseStyle = useAnimatedStyle(() => ({ transform: [{ translateY: rise.value }] }));
  const row = useRef<ViewInstance>(null);
  const measure = () =>
    row.current?.measureInWindow((_x, y, _width, height) => {
      if (height > 0) noteDeckBarTop(y);
    });
  useEffect(() => {
    watchDeckBar(measure);
    return () => watchDeckBar(null);
  }, []);
  const side = safeSide + MATERIAL_DECK.edge;
  const fabLabel = incognito ? "New Incognito Tab" : "New Tab";
  return (
    <Animated.View ref={row} testID="materialDeckBottomRow" onLayout={measure} pointerEvents="box-none" style={[styles.bottomRow, { bottom: safeBottom + MATERIAL_DECK.edge, left: side, right: side }, riseStyle]}>
      <Pressable accessible={false} onPress={() => input.current?.focus()} style={[styles.search, { backgroundColor: scheme.surfaceContainerHigh }]} testID="materialDeckSearch">
        <View pointerEvents="none">
          <Symbol name="magnifyingglass" size={materialSize.icon} color={scheme.onSurfaceVariant} />
        </View>
        <TextInput
          ref={input}
          testID="deckSearchField"
          accessibilityLabel="Search Tabs"
          placeholder="Search Tabs"
          placeholderTextColor={scheme.onSurfaceVariant}
          cursorColor={scheme.primary}
          selectionColor={withAlpha(scheme.primary, 0.4)}
          value={text}
          onChangeText={change}
          onFocus={focus}
          onBlur={blur}
          onSubmitEditing={() => input.current?.blur()}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={[materialType.bodyLarge, styles.field, { color: scheme.onSurface }]}
        />
        {text ? <MaterialIconButton testID="materialDeckSearchClear" icon="xmark" label="Clear Search" scheme={scheme} onPress={() => change("")} /> : null}
      </Pressable>
      <View testID="materialDeckFabShadow" style={[styles.fabShadow, { backgroundColor: scheme.primaryContainer }]}>
      <MenuTrigger
        items={plusMenuItems(incognito, canReopen)}
        trigger="longPress"
        haptic={menuOpenedHaptic}
        disabled={!menusShown}
        onOpen={() => onMenu(true)}
        onClose={() => onMenu(false)}
        place={{ bottom: materialSize.fab + MATERIAL_DECK.keyboardGap, right: 0 }}
        style={styles.fabSlot}
      >
        {({ onLongPress }) => (
            <Pressable
              testID="materialDeckFab"
              accessibilityRole="button"
              accessibilityLabel={fabLabel}
              accessibilityHint="Touch and hold for more options."
              android_ripple={ripple(scheme, scheme.onPrimaryContainer)}
              onPressIn={haptics.barPress}
              onPress={newTab}
              onLongPress={onLongPress}
              style={[styles.fab, { backgroundColor: scheme.primaryContainer }]}
            >
              <Symbol name="plus" size={materialSize.icon} color={scheme.onPrimaryContainer} />
            </Pressable>
        )}
      </MenuTrigger>
      </View>
    </Animated.View>
  );
}

export function MaterialDeckEmpty({ centerY, showsArchive, onArchive, searching = false, incognito }: { centerY: number; showsArchive: boolean; onArchive: () => void; searching?: boolean; incognito: boolean }) {
  const scheme = useDeckScheme(incognito);
  return (
    <View testID="materialDeckEmpty" pointerEvents="box-none" style={[styles.empty, { top: centerY - materialSize.listItemTwoLine }]}>
      <Text style={[materialType.titleLarge, styles.centered, { color: scheme.onSurface }]}>{searching ? "No Matching Tabs" : "No Open Tabs"}</Text>
      {searching ? null : <Text style={[materialType.bodyMedium, styles.centered, { color: scheme.onSurfaceVariant }]}>Tabs you open appear here. Inactive tabs move to the Archive.</Text>}
      {showsArchive && !searching ? (
        <Pressable accessibilityRole="button" android_ripple={ripple(scheme, scheme.primary)} onPress={onArchive} style={styles.textButton}>
          <Text style={[materialType.labelLarge, { color: scheme.primary }]}>Open Archive</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const noop = () => undefined;

const styles = StyleSheet.create({
  topBar: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center" },
  titleSlot: { flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 },
  title: { paddingHorizontal: MATERIAL_DECK.titleInset, flexShrink: 1 },
  shrink: { flexShrink: 1 },
  spaceButton: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: materialSize.touchTarget, paddingLeft: MATERIAL_DECK.titleInset, paddingRight: 8, borderRadius: materialShape.full, overflow: "hidden", flexShrink: 1 },
  chip: { flexDirection: "row", alignItems: "center", gap: 8, height: MATERIAL_DECK.chipHeight, paddingHorizontal: 12, borderRadius: materialShape.small, overflow: "hidden", marginHorizontal: 4 },
  count: { fontVariant: ["tabular-nums"] },
  iconButton: { width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center" },
  turned: { transform: [{ rotate: "90deg" }] },
  bottomRow: { position: "absolute", height: materialSize.fab, flexDirection: "row", alignItems: "center", gap: MATERIAL_DECK.rowGap },
  search: { flex: 1, height: materialSize.searchBar, flexDirection: "row", alignItems: "center", gap: MATERIAL_DECK.searchGap, paddingLeft: MATERIAL_DECK.edge, paddingRight: 4, borderRadius: materialShape.full, overflow: "hidden" },
  field: { flex: 1, paddingVertical: 0, includeFontPadding: false },
  fabSlot: { width: materialSize.fab, height: materialSize.fab },
  fabShadow: { width: materialSize.fab, height: materialSize.fab, borderRadius: materialShape.large, elevation: MATERIAL_DECK.fabElevation },
  fab: { width: materialSize.fab, height: materialSize.fab, borderRadius: materialShape.large, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  empty: { position: "absolute", left: 24, right: 24, alignItems: "center", gap: 8 },
  centered: { textAlign: "center" },
  textButton: { minHeight: materialSize.touchTarget, minWidth: materialSize.touchTarget, paddingHorizontal: 12, justifyContent: "center", alignItems: "center", borderRadius: materialShape.full, overflow: "hidden", marginTop: 8 },
});
