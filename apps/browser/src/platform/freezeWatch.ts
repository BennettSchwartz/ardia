import { NativeModules } from "react-native";

export type StallTally = {
  buckets: number[];
  longestMs: number;
  inputWaits: number;
  inputWaitMaxMs: number;
  gcMeasured: number;
  gcMs: number;
  gcLongestMs: number;
  gcBound: number;
};

export type FreezeWatch = {
  start(): boolean;
  setConsentEpoch(epoch: number): boolean;
  take(epoch: number): { main: StallTally; js: StallTally } | null;
};

export const freezeWatch = () => (NativeModules.ACFreezeWatch as FreezeWatch | undefined) ?? null;
