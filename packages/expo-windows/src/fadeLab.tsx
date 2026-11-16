import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { VisualEffect } from "./views/materials";
import { WindowDragRegion } from "./windowDragRegion";

export const FADE_LAB = { tile: 48, slot: 64, left: 24, top: 96, rounds: 6, roundMs: 2000, shownMs: 1400, fadeMs: 250 };

type Variant = { name: string; blur: boolean; layout: boolean; drag: boolean; later: boolean };

const SHAPES = [
  { name: "plain", blur: false, layout: false, drag: false },
  { name: "blur", blur: true, layout: false, drag: false },
  { name: "layout", blur: false, layout: true, drag: false },
  { name: "blur+layout", blur: true, layout: true, drag: false },
  { name: "overlay", blur: true, layout: true, drag: true },
];

export const FADE_VARIANTS: Variant[] = [false, true].flatMap((later) => SHAPES.map((shape) => ({ ...shape, name: `${shape.name}${later ? " later" : ""}`, later })));

const note = (text: string) => console.info(`[ardia windows] fade lab ${text}`);

function FadeTile({ variant, round, slot }: { variant: Variant; round: number; slot: number }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const begin = () => {
      note(`round ${round} ${variant.name} started`);
      Animated.timing(opacity, { toValue: 1, duration: FADE_LAB.fadeMs, easing: Easing.linear, useNativeDriver: true }).start(({ finished }) => note(`round ${round} ${variant.name} ended finished=${finished}`));
    };
    if (!variant.later) return begin();
    const frame = requestAnimationFrame(begin);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Animated.View
      style={[styles.tile, { left: FADE_LAB.left + slot * FADE_LAB.slot, opacity }]}
      onLayout={variant.layout ? (e) => setWidth(e.nativeEvent.layout.width) : undefined}
    >
      {variant.blur ? <VisualEffect material="fullScreenUI" blendingMode="withinWindow" style={StyleSheet.absoluteFill} /> : null}
      <View style={[StyleSheet.absoluteFill, styles.white, width > 0 ? { width } : null]} />
      {variant.drag ? <WindowDragRegion style={StyleSheet.absoluteFill} /> : null}
    </Animated.View>
  );
}

export function FadeLab() {
  const [round, setRound] = useState(1);
  useEffect(() => {
    note(`round 1 mounted`);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let next = 1; next <= FADE_LAB.rounds; next++) {
      timers.push(setTimeout(() => setRound(0), (next - 1) * FADE_LAB.roundMs + FADE_LAB.shownMs));
      if (next < FADE_LAB.rounds)
        timers.push(
          setTimeout(() => {
            note(`round ${next + 1} mounted`);
            setRound(next + 1);
          }, next * FADE_LAB.roundMs),
        );
    }
    return () => timers.forEach(clearTimeout);
  }, []);
  return (
    <View pointerEvents="none" style={styles.panel}>
      {round > 0 ? <View style={[styles.tile, styles.white, { left: FADE_LAB.left }]} /> : null}
      {round > 0 ? FADE_VARIANTS.map((variant, i) => <FadeTile key={`${round}-${variant.name}`} variant={variant} round={round} slot={i + 1} />) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { ...StyleSheet.absoluteFillObject, backgroundColor: "#000000" },
  tile: { position: "absolute", top: FADE_LAB.top, width: FADE_LAB.tile, height: FADE_LAB.tile },
  white: { backgroundColor: "#FFFFFF" },
});
