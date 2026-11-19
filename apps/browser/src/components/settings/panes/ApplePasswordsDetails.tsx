import { applePasswordsAvailable, openPasswordsApp } from "../../../state/site/passwords";
import { choosePasswordManager, ICLOUD_PASSWORDS_EXTENSION_ID, iCloudPasswordsExtensionOf, useProfilePasswordManager, useProfilesSharingChoice } from "../../../state/site/passwordManager";
import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { addFromWebStore, setEnabled } from "../../../state/extensions/actions";
import { useExtensionList } from "../../../state/extensions/store";
import { InstallDialogHost } from "../../extensions/ExtensionOverlays";
import { Box, Button, type Option, PopUp } from "../../ui";
import { useEffect, useState } from "react";
import { plural } from "../../../state/browser/model";
import type { PasswordManager } from "../../../state/settings/settings";
import { SETTINGS_WINDOW_ID } from "../../../state/settings/settingsWindows";
import { unlockPasswordsFor } from "../../../state/site/savedPasswords";
import { iCloudPasswordsExtensionSupported } from "../../../state/site/passwords";
import { Group, Row, SectionHeader } from "../Form";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { notePasswordManagerChosen } from "../../../state/telemetry/passwordManagerCounts";

function managerOptions(): Option<PasswordManager>[] {
  return [
    ...(applePasswordsAvailable() ? [{ value: "apple" as const, title: "Apple Passwords (iCloud Keychain)" }] : []),
    { value: "ardia", title: "Ardia" },
    { value: "none", title: "Another password manager" },
  ];
}

export function PasswordManagerRow({ profileId }: { profileId: string }) {
  return PLATFORM_FEATURES.applePasswords ? <PasswordManagerChoice profileId={profileId} /> : null;
}

function sharedChoiceNote(names: string[]): string | undefined {
  if (!names.length) return undefined;
  const others = names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;
  return `Also applies to ${others}, which ${names.length === 1 ? "shares" : "share"} this profile's browser data.`;
}

function PasswordManagerChoice({ profileId }: { profileId: string }) {
  const mode = useProfilePasswordManager(profileId);
  const sharing = useProfilesSharingChoice(profileId);
  return (
    <Row anchor="profiles.passwordManager" description={sharedChoiceNote(sharing)}>
      <PopUp value={mode} options={managerOptions()} onChange={(manager) => (notePasswordManagerChosen(manager), choosePasswordManager(profileId, manager))} minWidth={210} />
    </Row>
  );
}

export const OFFER_TO_SAVE_HANDED_OVER: Record<Exclude<PasswordManager, "ardia">, string> = {
  apple: "Apple Passwords fills logins in this profile, so Ardia doesn't offer to save them. Add new ones in the Passwords app.",
  none: "Your password manager extension handles logins in this profile, so Ardia doesn't offer to save them.",
};

export const OTHER_MANAGER_DESCRIPTION: Record<Exclude<PasswordManager, "ardia">, string> = {
  apple: "Uses the macOS Passwords app and iCloud Keychain across your Apple devices.",
  none: "Built-in password prompts are off so your password manager extension can handle logins.",
};

function useICloudPasswordsExtensionSupported() {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    void iCloudPasswordsExtensionSupported().then((value) => live && setSupported(value));
    return () => void (live = false);
  }, []);
  return supported;
}

export function ApplePasswordsDetails({ profile }: { profile: string }) {
  const extensionSupported = useICloudPasswordsExtensionSupported();
  const extensions = useExtensionList(profile);
  const iCloudExt = iCloudPasswordsExtensionOf(extensions);
  const extensionState = !iCloudExt ? "notInstalled" : iCloudExt.enabled ? "enabled" : "disabled";
  const installOrEnableExtension = () => {
    if (iCloudExt && !iCloudExt.enabled) return void setEnabled(profile, iCloudExt.id, true);
    void addFromWebStore(SETTINGS_WINDOW_ID, ICLOUD_PASSWORDS_EXTENSION_ID, profile);
    showSettingsSheet(<InstallDialogHost windowId={SETTINGS_WINDOW_ID} onClosed={closeSettingsSheet} />);
  };
  return (
    <>
      <SectionHeader title="Apple Passwords" description="Fill passwords, passkeys and verification codes from the macOS Passwords app." />
      <Group>
        <Row title="Passwords app" description="Manage saved passwords, passkeys, verification codes and Wi-Fi passwords in macOS Passwords.">
          <Button title="Open Passwords" kind="primary" onPress={() => void openPasswordsApp()} />
        </Row>
        {extensionSupported ? (
          <Row
            title="iCloud Passwords"
            description={extensionState === "enabled" ? "Paired with the macOS Passwords helper." : "Optional: pair with the iCloud Passwords extension from the Chrome Web Store."}
          >
            {extensionState !== "enabled" && <Button title={extensionState === "disabled" ? "Enable Extension" : "Add Extension…"} onPress={installOrEnableExtension} />}
          </Row>
        ) : null}
        <Row title="Filling a login" description="Click the key button in a username or password field, or choose Edit › AutoFill › Passwords…, then pick the login and approve with Touch ID. Apple doesn't tell the panel which site you're on, so search for it if it isn't near the top." />
        <Row title="Verification codes" description="Codes from Messages and Mail, and codes saved in Passwords, are offered in the same panel on a code field. When a site shows a two-factor setup QR code, Ardia offers to set it up in Passwords." />
        <Row title="Saving new logins" description="Apple doesn't let other browsers add logins to Passwords on the Mac yet, so add a new login with + in the Passwords app. Logins already saved in Ardia still fill." />
      </Group>
    </>
  );
}

export function SavedInArdiaDetails({
  profile,
  unlocked,
  loginCount,
  showList,
  onShowList,
  exportStatus,
  onExport,
}: {
  profile: string;
  unlocked: boolean;
  loginCount: number;
  showList: boolean;
  onShowList: (shown: boolean) => void;
  exportStatus: string;
  onExport: () => void;
}) {
  return (
    <>
      <SectionHeader
        title="Saved in Ardia"
        description={unlocked ? `${plural(loginCount, "password")} saved in Ardia's Keychain for this profile.` : "Passwords saved in Ardia before switching remain in your Keychain."}
      />
      <Group>
        <Row title="Move passwords to Apple Passwords" description={exportStatus || "Export a CSV here, then in the Passwords app choose File › Import Passwords…"}>
          <Box row gap="s">
            <Button title="Export CSV…" onPress={onExport} />
            <Button title="Open Passwords" onPress={() => void openPasswordsApp()} />
          </Box>
        </Row>
        <Row title="View passwords saved in Ardia" description="See or edit passwords that were saved in Ardia before switching.">
          <Button
            title={!unlocked ? "Unlock…" : showList ? "Hide Passwords" : `Show ${plural(loginCount, "Password")}`}
            onPress={() => {
              if (unlocked) onShowList(!showList);
              else void unlockPasswordsFor(profile).then((ok) => ok && onShowList(true));
            }}
          />
        </Row>
      </Group>
    </>
  );
}
