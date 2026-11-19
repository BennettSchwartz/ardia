import { usePages, pageOf, type PageState } from "../tabs/pageState";
import { answerPermission, ONE_TIME_KINDS, queuedPermissions } from "../site/permissions";
import { answerAutofillPrompt, answerPasswordPrompt } from "../site/prompts";
import { useBrowser, type BrowserState } from "../browser/store";
import { isEligibleTab } from "./automationWindows";
import type { MethodSpec } from "./socketCatalog";
import { obj, oneOf, TAB, text } from "./socketSchema";
import { now, tabOf } from "./socketTargets";
import type { EventSend } from "./storeEvents";
import { OpError } from "./workspaceTargets";

const PERMISSION_DECISIONS = ["allow", "allowOnce", "block", "dismiss"] as const;
const PASSWORD_DECISIONS = ["save", "update", "never", "notNow", "dismiss"] as const;
const AUTOFILL_DECISIONS = ["accept", "decline", "dismiss"] as const;

type Shown = { tab: string; window: string; page: PageState };

function shownPrompts(pick: (page: PageState) => unknown): Shown[] {
  const s = now();
  return Object.entries(usePages.getState().pages)
    .filter(([tabId, page]) => !!pick(page) && isEligibleTab(s, tabId))
    .map(([tabId, page]) => ({ tab: tabId, window: s.tabs[tabId]!.windowId, page }));
}

const permissionRow = ({ tab, window, page }: Shown) => {
  const p = page.permission!;
  return { id: p.id, window, tab, origin: p.origin, permissions: p.permissions, queued: queuedPermissions(tab) };
};

function permissionTab(id: string) {
  const shown = shownPrompts((p) => p.permission?.id === id)[0];
  if (!shown) throw new OpError("no_window", `There's no permission prompt ${id} on screen; permissions.prompts lists them.`);
  return shown;
}

function respondPermission(params: Record<string, unknown>) {
  const { tab, page } = permissionTab(params.id as string);
  const request = page.permission!;
  const decision = params.decision as (typeof PERMISSION_DECISIONS)[number];
  if (decision === "allowOnce") {
    const lasting = request.permissions.filter((k) => !ONE_TIME_KINDS.has(k));
    if (lasting.length) throw new OpError("refused", `${lasting.join(", ")} can't be allowed just this once; answer allow or block.`);
  }
  const result = decision === "allow" || decision === "allowOnce" ? "accept" : decision === "block" ? "deny" : "dismiss";
  const answered = answerPermission(tab, request.id, result, decision === "allow" || decision === "block");
  if (!answered) throw new OpError("failed", "The prompt closed before Ardia could answer it.");
  return { ok: true, id: request.id, decision };
}

const passwordRow = ({ tab, window, page }: Shown) => {
  const p = page.passwordPrompt!;
  return { tab, window, origin: p.origin, state: p.state, username: p.username, usernames: p.usernames, federation: p.federation || null };
};

function respondPassword(params: Record<string, unknown>) {
  const t = tabOf(params.tab);
  const prompt = pageOf(t.id).passwordPrompt;
  if (!prompt) throw new OpError("no_window", "That tab isn't showing a password prompt.");
  const decision = params.decision as (typeof PASSWORD_DECISIONS)[number];
  const update = prompt.state === "update";
  const fits = update ? decision === "update" || decision === "notNow" || decision === "dismiss" : decision !== "update";
  if (!fits) throw new OpError("bad_request", `The prompt asks to ${update ? "update" : "save"} a password; ${decision} isn't one of its buttons.`);
  const username = params.username as string | undefined;
  if (username !== undefined && !(update && prompt.usernames.length > 1 && prompt.usernames.includes(username))) {
    throw new OpError("bad_request", "username picks one of the prompt's usernames, and only when it offers a choice.");
  }
  const action = decision === "notNow" ? (update ? "nope" : "dismiss") : decision;
  if (!answerPasswordPrompt(t.id, action, username)) throw new OpError("failed", "The prompt closed before Ardia could answer it.");
  return { ok: true };
}

const autofillRow = ({ tab, window, page }: Shown) => {
  const p = page.autofillPrompt!;
  return { tab, window, kind: p.kind, origin: p.origin, title: p.title, message: p.message, accept: p.accept, decline: p.decline };
};

function respondAutofill(params: Record<string, unknown>) {
  const t = tabOf(params.tab);
  if (!answerAutofillPrompt(t.id, params.decision as (typeof AUTOFILL_DECISIONS)[number])) throw new OpError("no_window", "That tab isn't showing an autofill prompt.");
  return { ok: true };
}

export const PROMPT_METHODS: MethodSpec[] = [
  {
    name: "permissions.prompts",
    mutates: false,
    description: "Permission prompts on screen: one per tab, with how many more wait behind it",
    params: obj({}),
    result: "[{id, window, tab, origin, permissions, queued}]",
    run: () => shownPrompts((p) => p.permission).map(permissionRow),
  },
  {
    name: "permissions.respond",
    mutates: true,
    description: "Answer a permission prompt on screen, as its buttons do: allow and block are remembered, allowOnce lasts this visit (camera, microphone and location only), dismiss closes it",
    params: obj({ id: text("A prompt id from permissions.prompts"), decision: oneOf(PERMISSION_DECISIONS, "The answer") }, ["id", "decision"]),
    result: "{ok, id, decision}",
    run: respondPermission,
  },
  {
    name: "passwords.prompts",
    mutates: false,
    description: "Save and update password prompts on screen: the site and username, never the password",
    params: obj({}),
    result: "[{tab, window, origin, state, username, usernames, federation}]",
    run: () => shownPrompts((p) => p.passwordPrompt).map(passwordRow),
  },
  {
    name: "passwords.respond",
    mutates: true,
    description: "Answer a tab's password prompt with one of its buttons",
    params: obj({ tab: TAB, decision: oneOf(PASSWORD_DECISIONS, "save or never for a save prompt, update for an update prompt; notNow and dismiss for both"), username: text("For an update prompt that offers several usernames, the one to update") }, ["tab", "decision"]),
    result: "{ok}",
    run: respondPassword,
  },
  {
    name: "autofill.prompts",
    mutates: false,
    description: "Save address and save card prompts on screen, with their titles and buttons, never the card number",
    params: obj({}),
    result: "[{tab, window, kind, origin, title, message, accept, decline}]",
    run: () => shownPrompts((p) => p.autofillPrompt).map(autofillRow),
  },
  {
    name: "autofill.respond",
    mutates: true,
    description: "Answer a tab's save address or save card prompt with one of its buttons",
    params: obj({ tab: TAB, decision: oneOf(AUTOFILL_DECISIONS, "accept, decline or dismiss") }, ["tab", "decision"]),
    result: "{ok}",
    run: respondAutofill,
  },
];

export function startPromptEvents(send: EventSend, wants: ReadonlySet<string>) {
  const shownIn = (s: BrowserState, tabId: string) => isEligibleTab(s, tabId);
  return usePages.subscribe((state, prev) => {
    if (state.pages === prev.pages) return;
    const s = useBrowser.getState();
    for (const [tabId, page] of Object.entries(state.pages)) {
      const before = prev.pages[tabId];
      if (!shownIn(s, tabId)) continue;
      const window = s.tabs[tabId]!.windowId;
      if (wants.has("permission.prompted") && page.permission && page.permission.id !== before?.permission?.id) {
        send("permission.prompted", { windowId: window, tabId, ...permissionRow({ tab: tabId, window, page }) });
      }
      if (wants.has("password.prompted") && page.passwordPrompt && page.passwordPrompt !== before?.passwordPrompt) {
        const p = page.passwordPrompt;
        send("password.prompted", { windowId: window, tabId, origin: p.origin, state: p.state, username: p.username, usernames: p.usernames });
      }
    }
  });
}
