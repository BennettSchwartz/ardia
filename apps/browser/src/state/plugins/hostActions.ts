import type { HostAction } from "../../lib/pluginPageBar";
import { useBrowser } from "../browser/store";
import { openBarFromDeveloperBar, showSplitSidesMenu } from "../site/developerMode";
import { copyPageUrl } from "../site/selection";
import { togglePopover } from "../tabs/popoverDismiss";
import { webviews } from "../tabs/webviewHandles";
import { notePageBarPress } from "../telemetry/pageBarCounts";
import { publishedPageBar } from "./pageBarPanes";
import type { PageBarMatch } from "./pageBar";

function targetOf(windowId: string, tabId: string, action: HostAction, document?: { url: string; at: number }): PageBarMatch | null {
  const match = publishedPageBar(windowId, tabId);
  const tab = useBrowser.getState().tabs[tabId];
  if (!match || !tab || tab.windowId !== windowId || !match.spec.buttons.includes(action)) return null;
  if (document && (match.url !== document.url || match.at !== document.at)) return null;
  return match;
}

export function runHostAction(action: HostAction, windowId: string, tabId: string) {
  const match = targetOf(windowId, tabId, action);
  if (!match) return;
  notePageBarPress(action);
  switch (action) {
    case "siteControls":
      return togglePopover(tabId, "siteControls");
    case "address":
      return openBarFromDeveloperBar(windowId, tabId, match.url);
    case "copyLink":
      return void copyPageUrl(tabId);
    case "console":
    case "network":
    case "inspect":
      return void webviews.get(tabId)?.showDevTools(action);
    case "split":
      return void showSplitSidesMenu(tabId, () => targetOf(windowId, tabId, action, match) !== null);
    case "extensions":
      return;
  }
}

export const hostActionTarget = (action: HostAction, windowId: string, tabId: string): boolean => targetOf(windowId, tabId, action) !== null;
