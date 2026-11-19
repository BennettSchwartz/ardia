import { useSafeAreaInsets } from "react-native-safe-area-context";
import { bottomBarSpan, type BarSpan } from "../../lib/bottomBarSpan";
import { useScreenLayout } from "../../state/app/screenLayout";

export function useBottomBarSpan(width: number, side: number): BarSpan {
  const insets = useSafeAreaInsets();
  const hinge = useScreenLayout((s) => s.hinge);
  return bottomBarSpan(width, insets, hinge, side);
}
