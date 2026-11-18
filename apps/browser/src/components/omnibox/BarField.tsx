import type { SearchScope } from "@ardia/core";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";
import { Animated, findNodeHandle, StyleSheet, TextInput, View } from "react-native";
import { curve, duration, Text, useTheme } from "../ui";
import { reduceMotion } from "../ui/reduceMotion";
import { barFieldMarks } from "../../state/omnibox/barMarks";
import { PASTED_TYPES } from "./omniboxKeys";
import { useClaimFollowsFocus, type FocusClaim } from "./claimFollowsFocus";
import { useRevertRepair } from "./useRevertRepair";
import { BAR, BAR_TYPE } from "./tokens";

type InputProps = ComponentProps<typeof TextInput>;

export function BarField({
  inputRef,
  variant,
  floating,
  scope,
  incognito,
  focusEcho,
  onSelection,
  claim,
  placeholder,
  ...events
}: {
  inputRef: RefObject<TextInput | null>;
  focusEcho: RefObject<boolean>;
  onSelection(next: { start: number; end: number }): void;
  variant: "panel" | "hero" | "sidebar";
  floating: boolean;
  scope: SearchScope | null;
  incognito: boolean;
  claim?: FocusClaim;
  placeholder?: string;
} & Pick<InputProps, "value" | "onLayout" | "onChangeText" | "onSubmitEditing" | "onFocus" | "onBlur" | "keyDownEvents" | "onKeyDown">) {
  const theme = useTheme();
  const nativeText = useRef<string | null>(null);
  useLayoutEffect(() => {
    const native = nativeText.current;
    if (native !== null && events.value !== undefined && events.value !== native) barFieldMarks.write(variant, events.value.length, native.length);
  }, [events.value]);
  const tag = () => findNodeHandle(inputRef.current);
  useLayoutEffect(() => {
    const mounted = tag();
    barFieldMarks.field("mount", variant, mounted);
    return () => barFieldMarks.field("unmount", variant, mounted);
  }, []);
  const claimOnFocus = useClaimFollowsFocus(inputRef, claim);
  const repair = useRevertRepair(inputRef, variant, events.value, events.onChangeText, onSelection);
  const type = variant === "hero" ? BAR_TYPE.heroField : variant === "sidebar" || floating ? BAR_TYPE.floatingField : BAR_TYPE.panelField;
  const shownPlaceholder = placeholder ?? (scope ? `Search ${scope.name}` : incognito ? "Search privately or enter address" : "Search or enter address");
  const swap = usePlaceholderSwap(shownPlaceholder, !events.value);
  const field = (
    <TextInput
      ref={inputRef}
      {...events}
      onChangeText={repair.changed}
      onFocus={(e) => (barFieldMarks.field("focus", variant, tag()), claimOnFocus(), events.onFocus?.(e))}
      onBlur={(e) => (barFieldMarks.field("blur", variant, tag()), events.onBlur?.(e))}
      onLayout={(e) => (barFieldMarks.field(`layout ${Math.round(e.nativeEvent.layout.x)},${Math.round(e.nativeEvent.layout.y)} ${Math.round(e.nativeEvent.layout.width)}x${Math.round(e.nativeEvent.layout.height)}`, variant, tag()), events.onLayout?.(e))}
      onChange={(e) => {
        nativeText.current = e.nativeEvent.text;
        barFieldMarks.change(variant, e.nativeEvent.eventCount, e.nativeEvent.text.length);
      }}
      onSelectionChange={(e) => {
        const next = e.nativeEvent.selection;
        repair.selected(next);
        const length = events.value?.length ?? 0;
        if (focusEcho.current) {
          const atEnd = next.start === length && next.end === length;
          if (atEnd || (next.start === 0 && next.end === length)) {
            if (atEnd) focusEcho.current = false;
            return;
          }
          focusEcho.current = false;
        }
        onSelection(next);
      }}
      placeholder={swap ? "" : shownPlaceholder}
      placeholderTextColor={theme.placeholder}
      pastedTypes={PASTED_TYPES}
      selectionColor={theme.selection}
      enableFocusRing={false}
      style={{
        alignSelf: "stretch",
        ...type,
        color: theme.textPrimary,
        paddingVertical: 0,
        marginTop: variant === "panel" ? BAR.panelFieldLift : 0,
      }}
    />
  );
  const label = (text: string, opacity: Animated.AnimatedInterpolation<number> | Animated.Value) => (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { justifyContent: "center", paddingLeft: PLACEHOLDER_INSET, marginTop: variant === "panel" ? BAR.panelFieldLift : 0, opacity }]}>
      <Text lines={1} style={{ ...type, color: theme.placeholder }}>
        {text}
      </Text>
    </Animated.View>
  );
  return (
    <View style={{ flex: 1, justifyContent: "center" }}>
      {field}
      {swap ? label(swap.from, Animated.subtract(1, swap.progress)) : null}
      {swap ? label(swap.to, swap.progress) : null}
    </View>
  );
}

const PLACEHOLDER_INSET = 2;

function usePlaceholderSwap(text: string, empty: boolean) {
  const last = useRef(text);
  const progress = useRef(new Animated.Value(1)).current;
  const [swap, setSwap] = useState<{ from: string; to: string } | null>(null);
  if (last.current !== text) {
    const from = last.current;
    last.current = text;
    if (empty && !reduceMotion()) {
      progress.setValue(0);
      setSwap({ from: swap ? swap.to : from, to: text });
    } else if (swap) setSwap(null);
  }
  useEffect(() => {
    if (!swap) return;
    const run = Animated.timing(progress, { toValue: 1, duration: duration.base, easing: curve.fade, useNativeDriver: true });
    run.start(({ finished }) => finished && setSwap(null));
    return () => run.stop();
  }, [swap]);
  return swap && empty ? { ...swap, progress } : null;
}
