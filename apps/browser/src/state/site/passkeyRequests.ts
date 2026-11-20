import { confirm } from "../../platform/dialogs";
import { resolvePasskey, type PasskeyRequestEvent } from "../../platform/passwordProviders";
import { useBrowser } from "../browser/store";

const SOURCE_WORDS = { apple: "copied from Apple Passwords", ardia: "saved in Ardia" } as const;

const windowOf = (tabId: string) => useBrowser.getState().tabs[tabId]?.windowId;

async function pickAccount(tabId: string, request: PasskeyRequestEvent): Promise<number | null> {
  if (request.accounts.length === 1) return 0;
  for (let i = 0; i < request.accounts.length; i++) {
    const account = request.accounts[i]!;
    const last = i === request.accounts.length - 1;
    const answer = await confirm({
      title: `Sign in to ${request.site} with a passkey?`,
      message: `${account.displayName || account.name} (${account.name}), ${SOURCE_WORDS[account.source]}.`,
      confirmTitle: "Continue",
      cancelTitle: last ? "Use Another Device" : "Another Account",
      windowId: windowOf(tabId),
    });
    if (answer.confirmed) return i;
  }
  return null;
}

export async function answerPasskeyRequest(tabId: string, request: PasskeyRequestEvent) {
  if (request.kind === "create") return void resolvePasskey(request.id, "save");
  if (request.kind === "excluded") return void resolvePasskey(request.id, "excludedOk");
  const account = await pickAccount(tabId, request);
  void resolvePasskey(request.id, account === null ? "other" : "use", account ?? undefined);
}
