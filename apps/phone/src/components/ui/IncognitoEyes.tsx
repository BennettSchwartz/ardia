import Svg, { Ellipse } from "react-native-svg";

const SIDE = 24;
const EYE = { rx: 4.2, ry: 6.2, gap: 1.6 };
const EYE_CENTERS = [SIDE / 2 - EYE.gap / 2 - EYE.rx, SIDE / 2 + EYE.gap / 2 + EYE.rx];

export function IncognitoEyes({ size, color, testID }: { size: number; color: string; testID?: string }) {
  return (
    <Svg testID={testID} width={size} height={size} viewBox={`0 0 ${SIDE} ${SIDE}`}>
      {EYE_CENTERS.map((cx) => (
        <Ellipse key={cx} cx={cx} cy={SIDE / 2} rx={EYE.rx} ry={EYE.ry} fill={color} />
      ))}
    </Svg>
  );
}
