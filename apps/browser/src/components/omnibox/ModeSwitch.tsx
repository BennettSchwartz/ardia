import { memo, useEffect, useRef } from "react";
import { Animated, Pressable, View, type LayoutChangeEvent } from "react-native";
import { KeyCap, SlidingThumb, Text, useHover, useSlidingThumb, useTheme } from "../ui";
import { GlassFill, useGlass } from "../ui/Glass";
import { buttonMotion, duration, curve, usePressScaleMotion } from "../ui/motion";
import { reduceMotion } from "../ui/reduceMotion";
import type { NewTabModeOption } from "../../state/plugins/hooks";
import { MODE_SWITCH } from "./tokens";

export const SEARCH_MODE = "";

export const ModeSwitch = memo(function ModeSwitch({ modes, chosen, onChange }: { modes: readonly NewTabModeOption[]; chosen: string | null; onChange(plugin: string | null): void }) {
  const theme = useTheme();
  const glass = useGlass();
  const options = [{ value: SEARCH_MODE, title: "Search" }, ...modes.map((m) => ({ value: m.plugin, title: m.title }))];
  const current = chosen ?? SEARCH_MODE;
  const thumb = useSlidingThumb(current);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: MODE_SWITCH.hintGap, marginRight: MODE_SWITCH.after }}>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="New Tab mode"
        style={{
          height: MODE_SWITCH.height,
          borderRadius: MODE_SWITCH.radius,
          borderWidth: glass ? 0 : MODE_SWITCH.border,
          borderColor: theme.chipBorder,
          justifyContent: "center",
          paddingHorizontal: MODE_SWITCH.inset,
        }}
      >
        {glass ? <GlassFill radius={MODE_SWITCH.radius} /> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: MODE_SWITCH.gap, height: MODE_SWITCH.segmentHeight }}>
          <SlidingThumb x={thumb.x} width={thumb.width} style={{ borderRadius: MODE_SWITCH.segmentRadius, backgroundColor: glass ? undefined : theme.rowSelected }}>
            {glass ? <GlassFill radius={MODE_SWITCH.segmentRadius} state="active" /> : null}
          </SlidingThumb>
          {options.map((o) => (
            <Segment key={o.value} title={o.title} on={o.value === current} onLayout={(e) => thumb.measure(o.value, e)} onPress={() => onChange(o.value === SEARCH_MODE ? null : o.value)} />
          ))}
        </View>
      </View>
      <KeyCap keys={["tab"]} empty scale={MODE_SWITCH.keyScale} />
    </View>
  );
});

function useEmphasis(on: boolean) {
  const value = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion()) return value.setValue(on ? 1 : 0);
    const run = Animated.timing(value, { toValue: on ? 1 : 0, duration: duration.base, easing: curve.fade, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [on]);
  return value;
}

function Segment({ title, on, onPress, onLayout }: { title: string; on: boolean; onPress(): void; onLayout(e: LayoutChangeEvent): void }) {
  const { hovered, hoverProps } = useHover();
  const emphasis = useEmphasis(on);
  const pressMotion = usePressScaleMotion(true, buttonMotion.controlPressScale);
  const scaleStyle = pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null;
  return (
    <View {...hoverProps} onLayout={onLayout}>
      <Pressable onPress={onPress} onPressIn={pressMotion.onPressIn} onPressOut={pressMotion.onPressOut} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={title}>
        <Animated.View style={[{ height: MODE_SWITCH.segmentHeight, paddingHorizontal: MODE_SWITCH.segmentPad, justifyContent: "center" }, scaleStyle]}>
          <Animated.View style={{ opacity: Animated.subtract(1, emphasis) }}>
            <Text weight="semibold" tone={hovered ? "textSecondary" : "textTertiary"}>
              {title}
            </Text>
          </Animated.View>
          <Animated.View pointerEvents="none" style={{ position: "absolute", left: MODE_SWITCH.segmentPad, opacity: emphasis }}>
            <Text weight="semibold" tone="chipText">
              {title}
            </Text>
          </Animated.View>
        </Animated.View>
      </Pressable>
    </View>
  );
}
