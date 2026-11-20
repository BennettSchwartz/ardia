import { useEffect, useState } from "react";
import { View } from "react-native";
import { confirm } from "../../../state/app/system";
import { requestPluginConsent } from "../../../state/plugins/lifecycle";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { goToSettingsPane, SETTINGS_WINDOW_ID } from "../../../state/settings/settingsWindows";
import {
  askToTurnOnPasskeyAutofill,
  openPasswordsForImport,
  passkeyCountText,
  passkeyGroups,
  readPasskeySetup,
  removeAllPasskeys,
  usePasskeyCounts,
  usePasskeyGroups,
  usePasskeyImportState,
  type PasskeySetup,
} from "../../../state/site/passkeySetup";
import { Button, DialogActions, DialogTitle, Sheet, space, Text } from "../../ui";
import { Row } from "../Form";

const INTRO = "Copy your passkeys from Apple Passwords so sites can use them in Ardia.";
const SMALL_PRINT =
  "Passwords sends Ardia the whole export, including passwords, notes and cards. Ardia keeps only the passkeys, in this Mac's keychain, never synced or backed up, and each use asks for Touch ID or your password. It's a one-time copy: passkeys you add to Passwords later need another copy. Passkeys in iCloud Keychain can't be used directly, because Apple hasn't given Ardia that permission.";
const STEP_GAP = { gap: space.m, marginTop: space.l } as const;

let bumpCounts: () => void = () => {};
let setupAfterReview = false;

export function PasskeysRow({ name, review }: { name: string; review: boolean }) {
  const groups = usePasskeyGroups();
  const [refresh, setRefresh] = useState(0);
  const counts = usePasskeyCounts(groups, refresh);
  useEffect(() => {
    bumpCounts = () => setRefresh((n) => n + 1);
    return () => {
      bumpCounts = () => {};
    };
  }, []);
  useEffect(() => {
    if (review || !setupAfterReview || !groups.length) return;
    setupAfterReview = false;
    showSettingsSheet(<PasskeySetupSheet />);
  }, [review, groups.length]);
  if (review)
    return (
      <Row title="Passkeys" description="Apple Passwords now asks to keep passkeys for you. Review and turn it back on, then copy your passkeys.">
        <Button
          title="Set Up Passkeys…"
          onPress={() => {
            setupAfterReview = true;
            if (!requestPluginConsent(name)) setupAfterReview = false;
          }}
        />
      </Row>
    );
  if (!groups.length)
    return (
      <Row title="Passkeys" description="Pick Apple Passwords as the password manager for a profile first.">
        <Button title="Profiles…" onPress={() => goToSettingsPane("profiles", null)} />
      </Row>
    );
  const summary = counts ? passkeyCountText(counts) : "";
  return (
    <Row title="Passkeys" description={summary ? `${summary}. Copied from Apple Passwords.` : INTRO}>
      {summary ? <Button title="Remove…" onPress={() => void confirmRemove()} /> : null}
      <Button title={summary ? "Copy Again…" : "Set Up Passkeys…"} onPress={() => showSettingsSheet(<PasskeySetupSheet />)} />
    </Row>
  );
}

async function confirmRemove() {
  const groups = passkeyGroups();
  const answer = await confirm({
    title: "Remove the passkeys Ardia copied?",
    message: "Ardia deletes them from this Mac's keychain, along with any passkeys you made in Ardia. Apple Passwords keeps its own. Sites will ask you to sign in another way.",
    confirmTitle: "Remove",
    destructive: true,
    windowId: SETTINGS_WINDOW_ID,
  });
  if (!answer.confirmed) return;
  await removeAllPasskeys(groups);
  bumpCounts();
}

function stepText(phase: string | undefined, group: string | undefined, kept: number | undefined, existing: number | undefined): string {
  switch (phase) {
    case "received":
      return "Passwords sent the export. Choose where to copy the passkeys in the Ardia window that opened.";
    case "copying":
      return `Copying passkeys to ${group ?? "your profile"}…`;
    case "done": {
      const already = existing ? ` ${existing} were already in Ardia.` : "";
      return `Copied ${kept ?? 0} ${kept === 1 ? "passkey" : "passkeys"} to ${group ?? "your profile"}.${already}`;
    }
    case "failed":
      return "Couldn't copy passkeys. Start the export again in Passwords.";
    case "cancelled":
      return "Cancelled. Nothing was copied.";
    default:
      return "Waiting for Passwords… In Passwords, choose File › Export All Items to App…, pick Ardia, and confirm with Touch ID.";
  }
}

function PasskeySetupSheet() {
  const [since] = useState(() => Date.now());
  const [setup, setSetup] = useState<PasskeySetup | null>(null);
  const [opened, setOpened] = useState<boolean | null>(null);
  const state = usePasskeyImportState(since, true);
  const finished = state.phase === "done";
  useEffect(() => {
    void readPasskeySetup().then(setSetup);
    void openPasswordsForImport().then(setOpened);
  }, []);
  useEffect(() => {
    if (finished) bumpCounts();
  }, [finished]);
  const close = () => {
    bumpCounts();
    closeSettingsSheet();
  };
  if (setup && !setup.available)
    return (
      <Sheet size="s" onClose={close}>
        <DialogTitle subtitle={setup.reason === "macOS" ? "Copying passkeys from Apple Passwords needs macOS 26 or later." : "This build of Ardia can't receive passkeys from Passwords."}>
          Set Up Passkeys
        </DialogTitle>
        <DialogActions>
          <Button title="Done" kind="primary" onPress={close} />
        </DialogActions>
      </Sheet>
    );
  return (
    <Sheet size="m" onClose={close}>
      <DialogTitle subtitle={INTRO}>Set Up Passkeys</DialogTitle>
      <View style={STEP_GAP}>
        {setup?.autofillEnabled === false && !finished ? (
          <Row title="Turn on Ardia for AutoFill" description="If Passwords doesn't list Ardia, turn Ardia on in System Settings › General › AutoFill & Passwords. Ardia doesn't fill anything there.">
            <Button title="Turn On…" onPress={() => void askToTurnOnPasskeyAutofill(false).then(() => setTimeout(() => void readPasskeySetup().then(setSetup), 3000))} />
          </Row>
        ) : null}
        <Row title={finished ? "Done" : state.phase ? "In progress" : opened === false ? "Open Passwords" : "Passwords is open"} description={stepText(state.phase, state.group, state.kept, state.existing)}>
          {!finished ? <Button title="Open Passwords" onPress={() => void openPasswordsForImport().then(setOpened)} /> : null}
        </Row>
        <Text size="caption" tone="textSecondary">
          {SMALL_PRINT}
        </Text>
      </View>
      <DialogActions>
        <Button title={finished ? "Done" : "Close"} kind={finished ? "primary" : undefined} onPress={close} />
      </DialogActions>
    </Sheet>
  );
}
