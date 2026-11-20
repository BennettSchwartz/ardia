import Svg, { Path } from "react-native-svg";

const SIDE = 24;
const EYE = { rx: 4.2, ry: 6.2, gap: 1.6, lookAt: 14, lookReach: 3.2, lookOuter: 4.6, lookInner: 2.7 };
const EYE_CENTERS = [SIDE / 2 - EYE.gap / 2 - EYE.rx, SIDE / 2 + EYE.gap / 2 + EYE.rx];

const oval = (cx: number) => `M${cx - EYE.rx} ${SIDE / 2}A${EYE.rx} ${EYE.ry} 0 1 1 ${cx + EYE.rx} ${SIDE / 2}A${EYE.rx} ${EYE.ry} 0 1 1 ${cx - EYE.rx} ${SIDE / 2}Z`;

const lookingDown = (cx: number) => {
  const from = cx - EYE.lookReach;
  const to = cx + EYE.lookReach;
  return `M${from} ${EYE.lookAt}Q${cx} ${EYE.lookAt + EYE.lookOuter} ${to} ${EYE.lookAt}Q${cx} ${EYE.lookAt + EYE.lookInner} ${from} ${EYE.lookAt}Z`;
};

export const incognitoEyesPath = (incognito: boolean) => EYE_CENTERS.map((cx) => oval(cx) + (incognito ? lookingDown(cx) : "")).join("");

export function IncognitoEyes({ size, color, incognito = false, testID }: { size: number; color: string; incognito?: boolean; testID?: string }) {
  return (
    <Svg testID={testID} width={size} height={size} viewBox={`0 0 ${SIDE} ${SIDE}`}>
      <Path d={incognitoEyesPath(incognito)} fill={color} fillRule="evenodd" />
    </Svg>
  );
}
