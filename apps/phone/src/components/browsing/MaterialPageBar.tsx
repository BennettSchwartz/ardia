import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BrowserTab } from "../../state/tabs/tabModels";
import { Favicon, screenReaderActions, Symbol } from "../ui";
import { useMaterialRipple } from "../ui/MaterialSurfaces";
import { useMaterialTheme } from "../ui/materialTheme";
import { materialShape, materialSize, materialType } from "../ui/materialTokens";
import { barAddress, spokenAddress } from "./FloatingBar";
import { NotSecureLock } from "./NotSecureLock";
import { TabsMenuTrigger } from "./tabsMenu";

type Props = {
  tab: BrowserTab;
  order: BrowserTab[];
  showsPlus: boolean;
  onTabs: () => void;
  onTabsMenu: () => void;
  onStep: (delta: -1 | 1) => void;
  onAddress: () => void;
  onPlus: () => void;
  onMore: () => void;
};

const TAB_COUNT_BOX = 20;
const MAX_COUNT = 99;

export const tabCountLabel = (count: number) => (count > MAX_COUNT ? `${MAX_COUNT}+` : String(count));

export function MaterialPageBar({ tab, order, showsPlus, onTabs, onTabsMenu, onStep, onAddress, onPlus, onMore }: Props) {
  const { scheme } = useMaterialTheme();
  const field = useMaterialRipple();
  const icon = useMaterialRipple(true);
  const address = barAddress(tab);
  const count = order.length;
  return (
    <View testID="materialPageBar" style={styles.row}>
      <Pressable
        testID="materialAddressField"
        accessibilityRole="button"
        accessibilityLabel="Address"
        accessibilityValue={{ text: spokenAddress(address) }}
        accessibilityHint="Opens search with this page’s address."
        android_ripple={field}
        onPress={onAddress}
        style={[styles.field, { backgroundColor: tab.isPrivate ? scheme.inverseSurface : scheme.surfaceContainerHigh }]}
      >
        {address.isPrivate ? (
          <Symbol name="eyeglassesThin" size={materialSize.icon} color={scheme.inverseOnSurface} />
        ) : address.insecure ? (
          <NotSecureLock testID="materialBarNotSecure" size={20} color={scheme.error} />
        ) : address.pageUrl ? (
          <Favicon iconUrl={address.iconUrl} pageUrl={address.pageUrl} size={20} />
        ) : (
          <Symbol name="magnifyingglass" size={materialSize.icon} color={scheme.onSurfaceVariant} />
        )}
        <Text testID="materialBarHost" numberOfLines={1} ellipsizeMode="middle" style={[materialType.bodyLarge, styles.host, { color: tab.isPrivate ? scheme.inverseOnSurface : scheme.onSurface }]}>
          {address.host}
        </Text>
      </Pressable>
      {showsPlus ? (
        <Pressable testID="materialBarPlus" accessibilityRole="button" accessibilityLabel="New Search" android_ripple={icon} onPress={onPlus} style={styles.iconButton}>
          <Symbol name="plus" size={materialSize.icon} color={scheme.onSurfaceVariant} />
        </Pressable>
      ) : null}
      <TabsMenuTrigger order={order} onTabsMenu={onTabsMenu} style={styles.iconSlot}>
        {({ onLongPress, screenReaderActions: menuActions }) => (
          <Pressable
            testID="materialBarTabs"
            accessibilityRole="button"
            accessibilityLabel="Tabs"
            accessibilityValue={{ text: `${count} ${count === 1 ? "tab" : "tabs"}` }}
            accessibilityHint="Touch and hold for recent tabs."
            {...screenReaderActions([
              { name: "activate", run: onTabs },
              ...menuActions,
              { name: "previousTab", label: "Previous Tab", run: () => onStep(-1) },
              { name: "nextTab", label: "Next Tab", run: () => onStep(1) },
            ])}
            android_ripple={icon}
            onPress={onTabs}
            onLongPress={onLongPress}
            style={styles.iconButton}
          >
            <View testID="materialTabCount" style={[styles.countBox, { borderColor: scheme.onSurfaceVariant }]}>
              <Text style={[materialType.labelSmall, styles.count, { color: scheme.onSurfaceVariant }]}>{tabCountLabel(count)}</Text>
            </View>
          </Pressable>
        )}
      </TabsMenuTrigger>
      <Pressable testID="materialBarMore" accessibilityRole="button" accessibilityLabel="Page Menu" android_ripple={icon} onPress={onMore} style={styles.iconButton}>
        <View style={styles.vertical}>
          <Symbol name="ellipsis" size={materialSize.icon} color={scheme.onSurfaceVariant} />
        </View>
      </Pressable>
    </View>
  );
}

export function MaterialBarBand({ safeSide, ...bar }: Props & { safeSide: number }) {
  const { scheme } = useMaterialTheme();
  const insets = useSafeAreaInsets();
  return (
    <>
      <View testID="materialBarBand" style={[StyleSheet.absoluteFill, { backgroundColor: scheme.surfaceContainer }]} />
      <View style={[styles.band, { bottom: insets.bottom, paddingHorizontal: safeSide }]}>
        <MaterialPageBar {...bar} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  band: { position: "absolute", left: 0, right: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, height: materialSize.bottomBar },
  field: { flex: 1, height: materialSize.searchBar, borderRadius: materialShape.full, overflow: "hidden", flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 },
  host: { flex: 1 },
  iconSlot: { width: materialSize.touchTarget, height: materialSize.touchTarget },
  iconButton: { width: materialSize.touchTarget, height: materialSize.touchTarget, alignItems: "center", justifyContent: "center", borderRadius: materialShape.full },
  countBox: { minWidth: TAB_COUNT_BOX, height: TAB_COUNT_BOX, borderWidth: 2, borderRadius: materialShape.extraSmall, alignItems: "center", justifyContent: "center", paddingHorizontal: 2 },
  count: { textAlign: "center" },
  vertical: { transform: [{ rotate: "90deg" }] },
});
