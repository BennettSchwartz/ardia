export type DownloadFlightMark = {
  start: { x: number; y: number };
  target: { x: number; y: number };
  arc: number;
  icon: number;
  width: number;
  height: number;
  ms: number;
  fromPageEdge: boolean;
};

export type MarkDownloadFlight = (stage: "start" | "landed", flight: DownloadFlightMark) => void;

export const downloadFlightFromPageEdge = (): boolean => false;

export const markDownloadFlight: MarkDownloadFlight = () => {};
