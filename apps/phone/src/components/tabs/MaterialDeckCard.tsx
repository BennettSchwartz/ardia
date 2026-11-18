import { countUsage } from "../../state/telemetry/telemetry";
import { memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { withAlpha } from "../../lib/color";
import { DECK_HEADER, deckBarBand, deckHeaderIconReveal, deckStatusStrip, titleReveal } from "../../lib/deckGeometry";
import { shownTone } from "../../lib/pageTone";
import { snapshotPageTop } from "../../lib/shownSnapshots";
import { isUnseenReceived } from "../../lib/tabFace";
import { haptics } from "../../state/app/haptics";
import { countRender } from "../../state/app/interactionPerf";
import { useHeldPageTone } from "../../state/browse/deckHold";
import { display } from "../../state/search/omnibox";
import { useIncognito } from "../../state/tabs/hooks";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { barHeight, FadeView, Favicon, screenReaderActions, Symbol, TabFace, tabsInk, tabsLayout, usePageUnderBars, useTheme } from "../ui";
import { MATERIAL_STATE, rolesFromScheme } from "../ui/materialRoles";
import { materialShape, materialSize, materialType } from "../ui/materialTokens";
import { nativeMenus } from "../ui/MenuTrigger";
import { DeckCardMenu, deckCardStyles, ReceivedBadge, sameCard, useCardPlacement, type DeckCardProps } from "./DeckCard";
import { MATERIAL_DECK, useDeckScheme } from "./MaterialDeckLayout";

export const MaterialDeckCard = memo(function MaterialDeckCard({ tab, index, geometry: g, motion, onOpen, onClose, onCloseNow }: DeckCardProps) {
  countRender("DeckCard");
  const theme = useTheme();
  const scheme = useDeckScheme(tab.isPrivate);
  const backdrop = useDeckScheme(useIncognito());
  const roles = useMemo(() => (tab.isPrivate ? { ...theme, ...rolesFromScheme(scheme, true) } : theme), [tab.isPrivate, theme, scheme]);
  const tone = shownTone(useHeldPageTone(tab.id), tab.themeColorHex);
  const { scaleProgress } = motion;
  const { placed, cardStyle, reachStyle } = useCardPlacement(tab.id, g, motion, materialShape.large);
  const headerStyle = useAnimatedStyle(() => {
    const { pose: p, top } = placed.value;
    const left = p.x - (g.cardWidth * p.scale) / 2;
    return { zIndex: placed.value.z + 1, opacity: p.header, transform: [{ translateX: left + p.visible - g.cardWidth }, { translateY: top }] };
  });
  const rowStyle = useAnimatedStyle(() => {
    const room = placed.value.pose.visible - materialSize.touchTarget;
    return { opacity: deckHeaderIconReveal(room, tabsLayout.faviconSize), transform: [{ translateX: g.cardWidth - placed.value.pose.visible + MATERIAL_DECK.headerInset }] };
  });
  const titleStyle = useAnimatedStyle(() => ({ opacity: titleReveal(placed.value.pose.visible - materialSize.touchTarget) }));
  const closeStyle = useAnimatedStyle(() => ({ opacity: Math.min(Math.max((placed.value.pose.visible - MATERIAL_DECK.closeShownFrom) / DECK_HEADER.iconFade + 1, 0), 1) }));
  const underBars = usePageUnderBars();
  const pageTop = (tab.snapshotFileName ? snapshotPageTop(tab.snapshotFileName) : null) ?? (underBars ? 0 : g.safeTop);
  const faceStyle = useAnimatedStyle(() => ({ transform: [{ translateY: placed.value.expanded ? deckStatusStrip(g, scaleProgress.value, pageTop) : 0 }] }), [g, pageTop]);
  const bar = deckBarBand(g, barHeight(g.safeBottom), 1);
  const bandStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: placed.value.expanded && !underBars ? deckBarBand(g, 0, scaleProgress.value).grown : 0 }] }), [g, underBars]);
  const host = display(tab.url).host;
  const title = tab.title || host || "New Tab";
  const fill = tone.top ?? scheme.surfaceContainerLow;
  const cardContents = (
    <>
      <Animated.View testID="deckCardFace" style={[StyleSheet.absoluteFill, faceStyle]}>
        <TabFace tab={tab} title={title} host={host} tone={tone.top} roles={roles} paintedAs={`deck:${tab.id}`} />
      </Animated.View>
      <Animated.View testID="deckCardBarBand" pointerEvents="none" style={[deckCardStyles.band, { height: bar.height, backgroundColor: tone.bottom ?? theme.surface }, bandStyle]} />
      {isUnseenReceived(tab) ? <ReceivedBadge /> : null}
    </>
  );
  return (
    <>
      <Animated.View
        testID="deckCard"
        needsOffscreenAlphaCompositing
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.card, { width: g.cardWidth, height: g.cardHeight, backgroundColor: fill }, cardStyle]}
      >
        {nativeMenus() ? (
          <DeckCardMenu tab={tab} index={index} onClose={onClose} fill={fill}>
            {cardContents}
          </DeckCardMenu>
        ) : (
          cardContents
        )}
      </Animated.View>
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityValue={{ text: tab.isPrivate ? `Incognito, ${host}` : host }}
        accessibilityHint="Opens the tab."
        {...screenReaderActions([
          { name: "activate", run: () => onOpen(index) },
          { name: "close", label: "Close Tab", run: () => onCloseNow(index) },
        ])}
        pointerEvents="none"
        style={[deckCardStyles.reach, { width: g.cardWidth, height: g.cardHeight }, reachStyle]}
      />
      <Animated.View style={[styles.header, { width: g.cardWidth }, headerStyle]} pointerEvents="box-none">
        <FadeView testID="deckHeaderFade" trailing={{ length: DECK_HEADER.trailingFade }} pointerEvents="none" style={[styles.titleArea, { right: materialSize.touchTarget }]}>
          <Animated.View style={[styles.headerRow, rowStyle]}>
            <MaterialCardIcon tab={tab} />
            <Animated.Text testID="deckHeaderTitle" maxFontSizeMultiplier={DECK_HEADER.maxFontScale} style={[materialType.labelLarge, styles.title, { color: backdrop.onSurface }, titleStyle]} numberOfLines={1}>
              {title}
            </Animated.Text>
          </Animated.View>
        </FadeView>
        <Animated.View style={[styles.closeSlot, closeStyle]}>
          <MaterialCardClose
            title={title}
            color={backdrop.onSurfaceVariant}
            ripple={withAlpha(backdrop.onSurface, MATERIAL_STATE.pressed)}
            onPress={() => {
              const { header, visible } = placed.value.pose;
              if (header <= 0.5 || visible < MATERIAL_DECK.closeShownFrom) return;
              if (!tab.isPrivate) countUsage("card_close_tapped");
              onClose(index);
            }}
          />
        </Animated.View>
      </Animated.View>
    </>
  );
}, sameCard);

function MaterialCardClose({ title, color, ripple, onPress }: { title: string; color: string; ripple: string; onPress: () => void }) {
  return (
    <Pressable
      testID="materialCardClose"
      accessibilityRole="button"
      accessibilityLabel={`Close ${title}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      android_ripple={{ color: ripple, borderless: true, radius: MATERIAL_DECK.closeRipple }}
      onPressIn={haptics.barPress}
      onPress={onPress}
      style={styles.close}
    >
      <Symbol name="xmark" size={MATERIAL_DECK.closeIcon} color={color} />
    </Pressable>
  );
}

function MaterialCardIcon({ tab }: { tab: BrowserTab }) {
  const scheme = useDeckScheme(tab.isPrivate);
  const backdrop = useDeckScheme(useIncognito());
  if (!tab.isPrivate) return <Favicon iconUrl={tab.faviconUrl} pageUrl={tab.url} size={tabsLayout.faviconSize} />;
  return (
    <View testID="materialCardIncognitoIcon" style={[styles.privateIcon, { backgroundColor: scheme.surfaceContainerHighest }]}>
      <Symbol name="eyes" size={tabsLayout.faviconSize - 4} color={scheme.onSurface} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { position: "absolute", left: 0, top: 0, overflow: "hidden", elevation: MATERIAL_DECK.cardElevation, shadowColor: tabsInk.cardShadow },
  header: { position: "absolute", left: 0, top: 0, height: tabsLayout.headerHeight },
  titleArea: { position: "absolute", left: 0, top: 0, bottom: 0, overflow: "hidden" },
  headerRow: { position: "absolute", left: 0, top: 0, width: 2000, flexDirection: "row", alignItems: "center", gap: tabsLayout.headerSpacing + 2, height: tabsLayout.headerHeight },
  title: { includeFontPadding: false },
  closeSlot: { position: "absolute", right: 0, top: (tabsLayout.headerHeight - materialSize.touchTarget) / 2, width: materialSize.touchTarget, height: materialSize.touchTarget },
  close: { width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center", borderRadius: materialShape.full },
  privateIcon: { width: tabsLayout.faviconSize, height: tabsLayout.faviconSize, borderRadius: materialShape.full, alignItems: "center", justifyContent: "center" },
});
