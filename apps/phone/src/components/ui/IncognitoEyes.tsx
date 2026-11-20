import Svg, { Ellipse } from "react-native-svg";

const SIDE = 24;
const EYE = { rx: 4.1, ry: 6.4, gap: 1.6, pupil: 2.55, pupilDrop: 2.1, pupilShift: 0.7, outline: 1.3 };
const EYE_CENTERS = [SIDE / 2 - EYE.gap / 2 - EYE.rx, SIDE / 2 + EYE.gap / 2 + EYE.rx];

export const incognitoEyeInk = { sclera: "#FFFFFF", pupil: "#111114" } as const;

export function IncognitoEyes({ size, outline, opacity = 1, testID }: { size: number; outline: string; opacity?: number; testID?: string }) {
  return (
    <Svg testID={testID} width={size} height={size} viewBox={`0 0 ${SIDE} ${SIDE}`} opacity={opacity}>
      {EYE_CENTERS.map((cx) => (
        <Ellipse key={`sclera${cx}`} cx={cx} cy={SIDE / 2} rx={EYE.rx} ry={EYE.ry} fill={incognitoEyeInk.sclera} stroke={outline} strokeWidth={EYE.outline} />
      ))}
      {EYE_CENTERS.map((cx) => (
        <Ellipse key={`pupil${cx}`} cx={cx + EYE.pupilShift} cy={SIDE / 2 + EYE.pupilDrop} rx={EYE.pupil} ry={EYE.pupil * 1.15} fill={incognitoEyeInk.pupil} />
      ))}
    </Svg>
  );
}
