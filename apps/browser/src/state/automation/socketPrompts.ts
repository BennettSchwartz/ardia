import { usePages, pageOf, type PageState } from "../tabs/pageState";
import { answerPermissionConfirmed, answersJustOnce, confirmableKinds, queuedPermissions } from "../site/permissions";
import { answerAutofillPromptConfirmed, answerPasswordPromptConfirmed, passwordPromptId, type ConfirmedAnswer } from "../site/prompts";
import type { AutofillPrompt } from "../tabs/pageState";
import { useBrowser, type BrowserState } from "../browser/store";
import { isEligibleTab } from "./automationWindows";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { id, int, obj, oneOf, TAB, text } from "./socketSchema";
import { now, tabOf } from "./socketTargets";
import type { EventSend } from "./storeEvents";
import { OpError } from "./workspaceTargets";
import { clippedRow } from "./socketWire";

const PERMISSION_DECISIONS = ["allow", "allowOnce", "block", "dismiss"] as const;
const PASSWORD_DECISIONS = ["save", "update", "never", "notNow", "dismiss"] as const;
const AUTOFILL_DECISIONS = ["accept", "decline", "dismiss"] as const;
export const LISTED_USERNAMES = 20;
const USERNAME_CHARS = 256;

const CLOSED = "The prompt closed or changed before Ardia could answer it; list the prompts again.";

function confirmed(outcome: ConfirmedAnswer) {
  if (outcome === "gone") throw new OpError("no_window", CLOSED);
  if (outcome === "noView") throw new OpError("no_window", "That tab's page isn't open.");
  if (outcome === "refused") throw new OpError("failed", CLOSED);
}

type Shown = { tab: string; window: string; page: PageState };

function shownPrompts(pick: (page: PageState) => unknown): Shown[] {
  const s = now();
  return Object.entries(usePages.getState().pages)
    .filter(([tabId, page]) => !!pick(page) && isEligibleTab(s, tabId))
    .map(([tabId, page]) => ({ tab: tabId, window: s.tabs[tabId]!.windowId, page }));
}

const permissionRow = ({ tab, window, page }: Shown) => {
  const p = page.permission!;
  return clippedRow({ id: p.id, window, tab, origin: p.origin, permissions: p.permissions, queued: queuedPermissions(tab) });
};

function permissionTab(id: string) {
  const shown = shownPrompts((p) => p.permission?.id === id)[0];
  if (!shown) throw new OpError("no_window", `There's no permission prompt ${id} on screen; permissions.prompts lists them.`);
  return shown;
}

export const UNCONFIRMED = "Ardia can't confirm that answer until the engine reports a permission's result, so the ardia command doesn't give it; answer allow or block, or leave it to the prompt on screen.";

async function respondPermission(params: Record<string, unknown>, call: SocketCall) {
  const { tab, page } = permissionTab(params.id as string);
  const request = page.permission!;
  const decision = params.decision as (typeof PERMISSION_DECISIONS)[number];
  if (decision === "allowOnce" && !answersJustOnce(request.permissions)) {
    throw new OpError("refused", "Only camera, microphone and location can be allowed just this once; answer allow or block.");
  }
  if (decision === "allowOnce" || decision === "dismiss") throw new OpError("refused", UNCONFIRMED);
  if (!confirmableKinds(request.permissions)) throw new OpError("refused", `Ardia can't read back an answer for ${request.permissions.join(", ") || "this prompt"}, so the ardia command doesn't give it; leave it to the prompt on screen.`);
  call.stillServing();
  const outcome = await answerPermissionConfirmed(tab, request.id, decision === "allow" ? "accept" : "deny");
  if (outcome === "gone") throw new OpError("failed", CLOSED);
  if (outcome === "unknown") throw new OpError("failed", "The answer went to the engine but its outcome is unknown: the site's setting didn't show it within 5 s.");
  return { ok: true, id: request.id, decision };
}

const usernameList = (usernames: string[]) => ({
  usernames: usernames.slice(0, LISTED_USERNAMES).map((name, index) => ({ id: `u${index}`, name: name.slice(0, USERNAME_CHARS) })),
  usernameCount: usernames.length,
});

const usernameAt = (usernames: string[], usernameId: unknown) => {
  const match = typeof usernameId === "string" ? /^u(\d{1,4})$/.exec(usernameId) : null;
  return match ? usernames[Number(match[1])] : undefined;
};

const passwordRow = ({ tab, window, page }: Shown) => {
  const p = page.passwordPrompt!;
  return clippedRow({ id: passwordPromptId(p), tab, window, origin: p.origin, state: p.state, username: p.username, ...usernameList(p.usernames), federation: p.federation || null });
};

async function respondPassword(params: Record<string, unknown>, call: SocketCall) {
  const t = tabOf(params.tab);
  const prompt = pageOf(t.id).passwordPrompt;
  if (!prompt || passwordPromptId(prompt) !== params.id) throw new OpError("no_window", CLOSED);
  const decision = params.decision as (typeof PASSWORD_DECISIONS)[number];
  const update = prompt.state === "update";
  const fits = update ? decision === "update" || decision === "notNow" || decision === "dismiss" : decision === "save" || decision === "never" || decision === "notNow" || decision === "dismiss";
  if (!fits) throw new OpError("bad_request", `The prompt asks to ${update ? "update" : "save"} a password; ${decision} isn't one of its buttons.`);
  const username = params.usernameId === undefined ? undefined : usernameAt(prompt.usernames, params.usernameId);
  if (params.usernameId !== undefined && !(update && prompt.usernames.length > 1 && username !== undefined)) {
    throw new OpError("bad_request", "usernameId picks one of the prompt's usernames by its id, and only when it offers a choice.");
  }
  const action = decision === "notNow" ? (update ? "nope" : "dismiss") : decision;
  call.stillServing();
  confirmed(await answerPasswordPromptConfirmed(t.id, params.id as string, action, username));
  return { ok: true };
}

const AUTOFILL_DESCRIPTIONS: Record<AutofillPrompt["kind"], string> = {
  saveAddress: "Save a new address",
  updateAddress: "Update a saved address",
  saveCard: "Save a card",
};

export function autofillSummary(p: AutofillPrompt) {
  const fields = p.kind === "updateAddress" ? [...new Set((p.changes ?? []).map((c) => c.field))] : [];
  return { kind: p.kind, fields, description: fields.length ? `${AUTOFILL_DESCRIPTIONS[p.kind]}: ${fields.join(", ")} change` : AUTOFILL_DESCRIPTIONS[p.kind] };
}

const autofillRow = ({ tab, window, page }: Shown) => {
  const p = page.autofillPrompt!;
  return clippedRow({ id: p.id, tab, window, origin: p.origin, ...autofillSummary(p) });
};

async function respondAutofill(params: Record<string, unknown>, call: SocketCall) {
  const t = tabOf(params.tab);
  call.stillServing();
  confirmed(await answerAutofillPromptConfirmed(t.id, params.id as number, params.decision as (typeof AUTOFILL_DECISIONS)[number]));
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
    description: "Answer a permission prompt on screen with allow or block, remembered as the buttons do; the reply waits until the site's setting shows the answer. allowOnce and dismiss are refused until the engine reports their outcome",
    params: obj({ id: text("A prompt id from permissions.prompts"), decision: oneOf(PERMISSION_DECISIONS, "The answer") }, ["id", "decision"]),
    result: "{ok, id, decision}",
    run: respondPermission,
  },
  {
    name: "passwords.prompts",
    mutates: false,
    description: `Save and update password prompts on screen: the site and username, never the password. usernames lists at most ${LISTED_USERNAMES} as {id, name}, name cut to ${USERNAME_CHARS} characters; usernameCount says how many there are`,
    params: obj({}),
    result: "[{id, tab, window, origin, state, username, usernames, usernameCount, federation}]",
    run: () => shownPrompts((p) => p.passwordPrompt).map(passwordRow),
  },
  {
    name: "passwords.respond",
    mutates: true,
    description: "Answer a tab's password prompt with one of its buttons; refused when that tab now shows another prompt",
    params: obj(
      {
        tab: TAB,
        id: id("The prompt's id from passwords.prompts"),
        decision: oneOf(PASSWORD_DECISIONS, "save or never for a save prompt, update for an update prompt; notNow and dismiss for both"),
        usernameId: id("For an update prompt that offers several usernames, the id of the one to update, from usernames"),
      },
      ["tab", "id", "decision"],
    ),
    result: "{ok}",
    run: respondPassword,
  },
  {
    name: "autofill.prompts",
    mutates: false,
    description: "Save address, update address and save card prompts on screen: their kind and, for an update, which fields change; never the address, name or card",
    params: obj({}),
    result: "[{id, tab, window, origin, kind, fields, description}]",
    run: () => shownPrompts((p) => p.autofillPrompt).map(autofillRow),
  },
  {
    name: "autofill.respond",
    mutates: true,
    description: "Answer a tab's save address or save card prompt with one of its buttons; refused when that tab now shows another prompt",
    params: obj({ tab: TAB, id: int("The prompt's id from autofill.prompts", 1), decision: oneOf(AUTOFILL_DECISIONS, "accept, decline or dismiss") }, ["tab", "id", "decision"]),
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
        send("password.prompted", clippedRow({ windowId: window, tabId, id: passwordPromptId(p), origin: p.origin, state: p.state, username: p.username, ...usernameList(p.usernames) }));
      }
    }
  });
}
