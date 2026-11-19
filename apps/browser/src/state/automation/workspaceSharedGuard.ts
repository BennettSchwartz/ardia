import type { BrowserState } from "../browser/store";
import { innermostGroupOf, rootOf } from "../groups/groups";
import { groupLabel } from "../pins/tabGrouping";
import { sharedFolderOfGroup } from "../sharedFolders/removal";
import type { Op } from "./workspaceOps";
import { anchorRef, groupRef, OpError, store, tabRefs, type OpResult } from "./workspaceTargets";

export const SHARED_GROUPS_SIDEBAR_ONLY = "shared folder groups change only from the sidebar";

export function sharedRoot(s: BrowserState, groupId: string): string | null {
  const root = rootOf(s.groups, groupId);
  return root && sharedFolderOfGroup(s, root.id) ? root.id : null;
}

export function sharedRootOfTab(s: BrowserState, tabId: string): string | null {
  const g = innermostGroupOf(s.groups, tabId);
  return g ? sharedRoot(s, g.id) : null;
}

function sharedNamed(s: BrowserState, name: string): string | null {
  for (const g of Object.values(s.groups)) {
    if (g.name !== name && groupLabel(s, g) !== name) continue;
    const root = sharedRoot(s, g.id);
    if (root) return root;
  }
  return null;
}

function groupField(s: BrowserState, results: OpResult[], ref: unknown): string | null {
  if (ref === undefined || ref === null) return null;
  if (typeof ref === "object" && typeof (ref as { name?: unknown }).name === "string") return sharedNamed(s, (ref as { name: string }).name);
  return sharedRoot(s, groupRef(results, ref).id);
}

function insideAnchor(s: BrowserState, results: OpResult[], ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const anchor = anchorRef(results, ref);
  if (anchor.kind === "tab") return sharedRootOfTab(s, anchor.id);
  const root = sharedRoot(s, anchor.id);
  return root && root !== anchor.id ? root : null;
}

function tabsField(results: OpResult[], value: unknown): string[] {
  if (Array.isArray(value)) return tabRefs(results, value as string[]);
  return typeof value === "string" ? tabRefs(results, [value]) : [];
}

function sharedTouched(s: BrowserState, results: OpResult[], op: Op): string | null {
  const members = (field: string) => tabsField(results, op[field]).map((id) => sharedRootOfTab(s, id)).find(Boolean) ?? null;
  const destination = () => groupField(s, results, op.group) ?? groupField(s, results, op.parent) ?? insideAnchor(s, results, op.before) ?? insideAnchor(s, results, op.after);
  switch (op.op) {
    case "open":
      return destination();
    case "tab.move":
    case "group.create":
      return members("tabs") ?? destination();
    case "tab.pin":
    case "tab.unpin":
    case "tab.close":
      return members("tabs");
    case "tab.rename":
      return members("tab");
    case "group.update":
      return op.name !== undefined ? groupField(s, results, op.group) : null;
    case "group.move":
      return groupField(s, results, op.group) ?? groupField(s, results, op.parent) ?? insideAnchor(s, results, op.before) ?? insideAnchor(s, results, op.after);
    case "group.ungroup":
    case "group.close":
    case "group.delete":
      return groupField(s, results, op.group);
    default:
      return null;
  }
}

export function refuseSharedFolderChange(results: OpResult[], op: Op) {
  const hit = sharedTouched(store(), results, op);
  if (hit) throw new OpError("refused", `Group ${hit} is a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}.`);
}

export function refuseSharedTabs(tabIds: string[]) {
  const s = store();
  const hit = tabIds.map((id) => sharedRootOfTab(s, id)).find(Boolean);
  if (hit) throw new OpError("refused", `Group ${hit} is a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}.`);
}

export function refuseSyncedLinkChange(tabId: string | null | undefined, what: string) {
  const s = store();
  const t = tabId ? s.tabs[tabId] : undefined;
  if (!t || t.pinnedUrl) return;
  const hit = sharedRootOfTab(s, t.id);
  if (hit) throw new OpError("refused", `Tab ${t.id} is a link in shared folder ${hit}, and ${what} would change the link it syncs; ${SHARED_GROUPS_SIDEBAR_ONLY}.`);
}

export function refuseSharedRunCommand(command: string, tabId: string | null) {
  if (!tabId) return;
  if (command === "back" || command === "forward") return refuseSyncedLinkChange(tabId, command === "back" ? "going back" : "going forward");
  if (command !== "closeTab" && command !== "closeTabGroup") return;
  const hit = sharedRootOfTab(store(), tabId);
  if (hit) throw new OpError("refused", `Group ${hit} is a shared folder; ${SHARED_GROUPS_SIDEBAR_ONLY}, so ${command} didn't run.`);
}
