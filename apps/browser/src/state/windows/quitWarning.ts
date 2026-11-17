import { confirm } from "../../platform/dialogs";
import { isPopupWindowId, windowIds } from "../../platform/windows";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { backgroundInstance } from "../app/appSettings";
import { useBrowser } from "../browser/store";
import { isUtilityWindowId } from "../settings/settingsWindows";
import { isWindowClosing } from "./closingWindows";
import { downloadsInProgress } from "../downloads/status";
import { noteQuitAskedWithDownloads } from "../telemetry/quitWarningCounts";

export const QUIT_WARNING = {
  title: "Are you sure you want to quit Ardia?",
  message: "Your windows and tabs will be restored the next time you open it.",
  confirmTitle: "Quit",
  suppression: "Don’t ask again",
} as const;

export const downloadsQuitWarning = (count: number) =>
  ({
    title: QUIT_WARNING.title,
    message: count === 1 ? "You have 1 download in progress. If you quit now, this download will be cancelled." : `You have ${count} downloads in progress. If you quit now, these downloads will be cancelled.`,
    confirmTitle: QUIT_WARNING.confirmTitle,
  }) as const;

export type QuitWarning = "notAsked" | "confirmed" | "cancelled";

type Closing = { quitsWithLastWindow: boolean; background: boolean; staysOpen: readonly string[] };
type Asking = Closing & { warns: boolean };

export const closeQuits = (closing: Closing) => closing.quitsWithLastWindow && !closing.background && closing.staysOpen.length === 0;

export const asksBeforeQuit = (asking: Asking) => closeQuits(asking) && asking.warns;

export function windowsStayingOpen(openWindowIds: readonly string[], closing: string, browserWindowIds: ReadonlySet<string>, isClosing: (id: string) => boolean) {
  if (openWindowIds.length === 0) return [closing];
  return openWindowIds.filter((id) => id !== closing && !isClosing(id) && (browserWindowIds.has(id) || isUtilityWindowId(id) || isPopupWindowId(id)));
}

export function quitWarningMayAsk() {
  if (!PLATFORM_FEATURES.quitsWithLastWindow || backgroundInstance) return false;
  const s = useBrowser.getState();
  return s.settings.warnBeforeQuitting || downloadsInProgress(s.downloads) > 0;
}

const asking = new Set<string>();

async function closeStillQuits(windowId: string) {
  const openWindowIds = await windowIds().catch(() => [] as string[]);
  const staysOpen = windowsStayingOpen(openWindowIds, windowId, new Set(Object.keys(useBrowser.getState().windows)), isWindowClosing);
  return closeQuits({ quitsWithLastWindow: true, background: false, staysOpen });
}

export async function askBeforeQuitting(windowId: string, ask: typeof confirm = confirm, { warning = true }: { warning?: boolean } = {}): Promise<QuitWarning> {
  if (!quitWarningMayAsk()) return "notAsked";
  if (asking.has(windowId)) return "cancelled";
  asking.add(windowId);
  try {
    const wasBrowserWindow = windowId in useBrowser.getState().windows;
    const quits = await closeStillQuits(windowId);
    if (wasBrowserWindow && !useBrowser.getState().windows[windowId]) return "notAsked";
    if (!quits) return "notAsked";
    let answer: QuitWarning = "notAsked";
    if (warning && useBrowser.getState().settings.warnBeforeQuitting) {
      const { confirmed, suppressed } = await ask({ ...QUIT_WARNING, windowId });
      if (suppressed) useBrowser.getState().updateSettings({ warnBeforeQuitting: false });
      if (!confirmed) return "cancelled";
      answer = "confirmed";
      if (!(await closeStillQuits(windowId))) return answer;
    }
    const running = downloadsInProgress(useBrowser.getState().downloads);
    if (running > 0) {
      const { confirmed } = await ask({ ...downloadsQuitWarning(running), windowId });
      noteQuitAskedWithDownloads(!confirmed);
      if (!confirmed) return "cancelled";
      answer = "confirmed";
    }
    return answer;
  } finally {
    asking.delete(windowId);
  }
}
