import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { curve, duration } from "../ui/motion";
import { reduceMotion } from "../ui/reduceMotion";

export function CrossFade({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  const [shown, setShown] = useState({ key: swapKey, node: children });
  const [leaving, setLeaving] = useState<{ key: string; node: ReactNode } | null>(null);
  const fade = useRef(new Animated.Value(1)).current;
  if (shown.key === swapKey && shown.node !== children) setShown({ key: swapKey, node: children });
  if (shown.key !== swapKey) {
    setLeaving(reduceMotion() ? null : shown);
    setShown({ key: swapKey, node: children });
    fade.setValue(reduceMotion() ? 1 : 0);
  }
  useEffect(() => {
    if (!leaving) return;
    const run = Animated.timing(fade, { toValue: 1, duration: duration.base, easing: curve.fade, useNativeDriver: true });
    run.start(({ finished }) => finished && setLeaving(null));
    return () => run.stop();
  }, [leaving]);
  return (
    <View>
      {leaving ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: Animated.subtract(1, fade), alignItems: "center", justifyContent: "center" }]}>
          {leaving.node}
        </Animated.View>
      ) : null}
      <Animated.View style={{ opacity: fade }}>{shown.node}</Animated.View>
    </View>
  );
}
