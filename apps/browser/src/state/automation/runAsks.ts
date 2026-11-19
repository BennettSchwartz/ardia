import type { BrowserState } from "../browser/store";
import { closesWindow } from "../browser/model";
import { commandTarget } from "../commands/commandTarget";
import { rootOf } from "../groups/groupNesting";
import { leavesEmptyWindow } from "../omnibox/newTabBarPolicy";
import { groupOf } from "../pins/tabGrouping";
import { sharedFolderOfGroup } from "../sharedFolders/removal";
import { pageOf } from "../tabs/pageState";
import { liveOf } from "../tabs/tabLive";
import { asksBeforeClosingLastTab } from "../windows/windowClose";
import { quitWarningMayAsk } from "../windows/quitWarning";
import type { RunPlan } from "./automationMethods";

export type RunNeedsUser = "asks" | "picker";

const PICKERS: ReadonlySet<string> = new Set(["openFile", "exportBookmarks", "savePage", "printWithSystemDialog", "share"]);

function closeTabAsks(s: BrowserState, windowId: string, tabId: string | null) {
  if (!tabId || !s.tabs[tabId] || !closesWindow(s, tabId) || leavesEmptyWindow(s, tabId)) return false;
  return asksBeforeClosingLastTab(windowId) || quitWarningMayAsk();
}

function closeGroupAsks(s: BrowserState, tabId: string | null) {
  const group = groupOf(s, tabId ?? undefined);
  if (!group) return false;
  if (sharedFolderOfGroup(s, group.id)) return true;
  return s.settings.warnBeforeClosingTabGroup && !rootOf(s.groups, group.id)?.pinned;
}

function windowCommandAsks(s: BrowserState, plan: RunPlan, windowId: string, tabId: string | null, targeted: boolean) {
  switch (plan.command) {
    case "closeTab": {
      const ui = s.windowUi[windowId];
      if (!targeted && ((ui?.panel.open && !ui.panel.newTab) || (s.selection[windowId]?.length ?? 0) > 1)) return false;
      return closeTabAsks(s, windowId, tabId);
    }
    case "closeTabGroup":
      return closeGroupAsks(s, tabId);
    case "back":
      return !!tabId && !!pageOf(tabId).engineBack && !liveOf(tabId).canGoBack;
    default:
      return false;
  }
}

export function runNeedsUser(s: BrowserState, plan: RunPlan): RunNeedsUser | null {
  const target = commandTarget(s, plan.command, plan.windowId, plan.tabId);
  switch (target.kind) {
    case "utility":
      return plan.command === "closeTab" && quitWarningMayAsk() ? "asks" : null;
    case "little": {
      const tab = target.tabId ? s.tabs[target.tabId] : undefined;
      const closesPanel = s.windowUi[target.windowId]?.panel.open && !!tab?.url;
      return plan.command === "closeTab" && !closesPanel && quitWarningMayAsk() ? "asks" : null;
    }
    case "window":
      if (PICKERS.has(plan.command) && !(plan.command === "share" && plan.arg?.startsWith("via:")) && (plan.command === "openFile" || target.windowId)) return "picker";
      if (!target.windowId) return null;
      return windowCommandAsks(s, plan, target.windowId, target.tabId, !!target.targeted) ? "asks" : null;
    default:
      return null;
  }
}
