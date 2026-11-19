import type { BrowserState } from "../browser/store";
import { activeTabId, closesWindow } from "../browser/model";
import { rootOf } from "../groups/groupNesting";
import { leavesEmptyWindow } from "../omnibox/newTabBarPolicy";
import { groupOf } from "../pins/tabGrouping";
import { sharedFolderOfGroup } from "../sharedFolders/removal";
import { pageOf } from "../tabs/pageState";
import { liveOf } from "../tabs/tabLive";
import { asksBeforeClosingLastTab } from "../windows/windowClose";
import { quitWarningMayAsk } from "../windows/quitWarning";
import type { RunPlan } from "./automationMethods";

function closeTabAsks(s: BrowserState, windowId: string, tabId: string | undefined) {
  if (!tabId || !s.tabs[tabId] || !closesWindow(s, tabId) || leavesEmptyWindow(s, tabId)) return false;
  return asksBeforeClosingLastTab(windowId) || quitWarningMayAsk();
}

function closeGroupAsks(s: BrowserState, tabId: string | undefined) {
  const group = groupOf(s, tabId);
  if (!group) return false;
  if (sharedFolderOfGroup(s, group.id)) return true;
  return s.settings.warnBeforeClosingTabGroup && !rootOf(s.groups, group.id)?.pinned;
}

export function runWouldAsk(s: BrowserState, plan: RunPlan): boolean {
  if (!plan.windowId) return false;
  const tabId = plan.tabId ?? activeTabId(s, plan.windowId) ?? undefined;
  switch (plan.command) {
    case "closeTab":
      return closeTabAsks(s, plan.windowId, tabId);
    case "closeTabGroup":
      return closeGroupAsks(s, tabId);
    case "back":
      return !!tabId && !!pageOf(tabId).engineBack && !liveOf(tabId).canGoBack;
    default:
      return false;
  }
}
