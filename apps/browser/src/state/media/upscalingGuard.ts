import type { CrashReport } from "@ardia/shell";
import { crashReports, systemInfo } from "../../platform/app";
import { readDocument, writeDocument } from "../../platform/documents";
import { isFields } from "../../lib/decode";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { parseSaved, versionedJson } from "../../lib/savedDocument";
import { capture } from "../telemetry/client";

const DOC = "video-upscaling-guard.json";
const DOC_VERSION = 1;
const CHECK_EVERY_MS = 10 * 60_000;
const FIRST_CHECK_MS = 3_000;
const SCALER_SYMBOL = /\b(?:VTFrameProcessor|VTLowLatencySuperResolutionScaler\w*)\b/;

export type UpscalingGuard = { appVersion: string; since: number; checkedUntil: number; suspended: boolean };

export const isScalerCrash = (report: Pick<CrashReport, "process" | "frames" | "exceptionFrames">) =>
  report.process === "gpu" && [...report.frames, ...(report.exceptionFrames ?? [])].some((frame) => SCALER_SYMBOL.test(frame.symbol ?? ""));

export function freshGuard(saved: UpscalingGuard | null, appVersion: string, now: number): UpscalingGuard {
  if (saved && saved.appVersion === appVersion) return saved;
  return { appVersion, since: now, checkedUntil: now, suspended: false };
}

export function afterReports(guard: UpscalingGuard, reports: readonly CrashReport[]): { guard: UpscalingGuard; scalerCrashes: number } {
  let checkedUntil = guard.checkedUntil;
  let scalerCrashes = 0;
  for (const report of reports) {
    const at = report.fileTime ?? report.time;
    checkedUntil = Math.max(checkedUntil, at);
    if (report.time >= guard.since && isScalerCrash(report)) scalerCrashes++;
  }
  return { guard: { ...guard, checkedUntil, suspended: guard.suspended || scalerCrashes > 0 }, scalerCrashes };
}

function readGuard(): UpscalingGuard | null {
  try {
    const doc = parseSaved(readDocument(DOC), DOC_VERSION);
    if (!doc || !isFields(doc)) return null;
    const { appVersion, since, checkedUntil, suspended } = doc;
    if (typeof appVersion !== "string" || typeof since !== "number" || typeof checkedUntil !== "number" || typeof suspended !== "boolean") return null;
    return { appVersion, since, checkedUntil, suspended };
  } catch {
    return null;
  }
}

function saveGuard(guard: UpscalingGuard) {
  try {
    writeDocument(DOC, versionedJson(guard, DOC_VERSION));
  } catch (error) {
    console.warn("[media] couldn't save the video upscaling guard", error);
  }
}

let guard: UpscalingGuard | null = null;
let wanted: boolean | null = null;
let apply: ((enabled: boolean) => unknown) | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let checking = false;

const current = () => (guard ??= freshGuard(readGuard(), systemInfo().appVersion ?? "", Date.now()));

export const upscalingSuspended = () => PLATFORM_FEATURES.videoUpscaling && current().suspended;

export function upscalingWanted(enabled: boolean, send: (enabled: boolean) => unknown) {
  apply = send;
  if (PLATFORM_FEATURES.videoUpscaling && enabled && wanted === false && current().suspended) {
    guard = { ...current(), suspended: false };
    saveGuard(guard);
  }
  wanted = enabled;
  return send(enabled && !upscalingSuspended());
}

async function check() {
  if (checking) return;
  checking = true;
  try {
    const before = current();
    const reports = await crashReports(before.checkedUntil).catch(() => [] as CrashReport[]);
    const { guard: next, scalerCrashes } = afterReports(current(), reports);
    guard = next;
    if (next.checkedUntil !== before.checkedUntil || next.suspended !== before.suspended) saveGuard(next);
    if (next.suspended && !before.suspended) {
      if (wanted) void apply?.(false);
      capture("video_upscaling_suspended", { crashes: scalerCrashes, setting_on: wanted === true });
    }
  } finally {
    checking = false;
  }
}

export function startUpscalingGuard() {
  if (!PLATFORM_FEATURES.videoUpscaling || timer) return;
  setTimeout(() => void check(), FIRST_CHECK_MS);
  timer = setInterval(() => void check(), CHECK_EVERY_MS);
}
