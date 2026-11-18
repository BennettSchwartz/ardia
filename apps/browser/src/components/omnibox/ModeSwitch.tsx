import { memo } from "react";
import { Pressable, View } from "react-native";
import { Text, useHover, useTheme } from "../ui";
import { GlassFill, useGlass } from "../ui/Glass";
import type { NewTabModeOption } from "../../state/plugins/hooks";
import { MODE_SWITCH } from "./tokens";

export const SEARCH_MODE = "";

export const ModeSwitch = memo(function ModeSwitch({ modes, chosen, onChange }: { modes: readonly NewTabModeOption[]; chosen: string | null; onChange(plugin: string | null): void }) {
  const theme = useTheme();
  const glass = useGlass();
  const options = [{ value: SEARCH_MODE, title: "Search" }, ...modes.map((m) => ({ value: m.plugin, title: m.title }))];
  const current = chosen ?? SEARCH_MODE;
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel="New Tab mode"
      style={{
        height: MODE_SWITCH.height,
        borderRadius: MODE_SWITCH.radius,
        borderWidth: glass ? 0 : MODE_SWITCH.border,
        borderColor: theme.chipBorder,
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: MODE_SWITCH.inset,
        gap: MODE_SWITCH.gap,
        marginRight: MODE_SWITCH.after,
      }}
    >
      {glass ? <GlassFill radius={MODE_SWITCH.radius} /> : null}
      {options.map((o) => (
        <Segment key={o.value} title={o.title} on={o.value === current} onPress={() => onChange(o.value === SEARCH_MODE ? null : o.value)} />
      ))}
      <View style={{ height: MODE_SWITCH.keyHeight, minWidth: MODE_SWITCH.keyMinWidth, paddingHorizontal: MODE_SWITCH.keyPad, borderRadius: MODE_SWITCH.keyRadius, borderWidth: MODE_SWITCH.border, borderColor: theme.chipBorder, alignItems: "center", justifyContent: "center", marginLeft: MODE_SWITCH.keyBefore }}>
        <Text size="tiny" tone="textTertiary">
          tab
        </Text>
      </View>
    </View>
  );
});

function Segment({ title, on, onPress }: { title: string; on: boolean; onPress(): void }) {
  const theme = useTheme();
  const glass = useGlass();
  const { hovered, hoverProps } = useHover();
  return (
    <View {...hoverProps}>
      <Pressable onPress={onPress} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={title}>
        <View
          style={{
            height: MODE_SWITCH.segmentHeight,
            borderRadius: MODE_SWITCH.segmentRadius,
            paddingHorizontal: MODE_SWITCH.segmentPad,
            justifyContent: "center",
            backgroundColor: glass ? undefined : on ? theme.rowSelected : hovered ? theme.rowHover : undefined,
          }}
        >
          {glass && (on || hovered) ? <GlassFill radius={MODE_SWITCH.segmentRadius} state={on ? "active" : "lit"} /> : null}
          <Text weight={on ? "semibold" : "medium"} tone={on ? "chipText" : "textTertiary"}>
            {title}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}
