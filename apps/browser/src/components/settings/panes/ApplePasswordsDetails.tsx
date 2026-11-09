import { applePasswordsAvailable, openPasswordsApp } from "../../../state/site/passwords";
import { ICLOUD_PASSWORDS_EXTENSION_ID, iCloudPasswordsExtensionOf, useEffectivePasswordManager } from "../../../state/site/passwordManager";
import { addFromWebStore, setEnabled } from "../../../state/extensions/actions";
import { useExtensionList } from "../../../state/extensions/store";
import { InstallDialogHost } from "../../extensions/ExtensionOverlays";
import { Box, Button, type Option, PopUp } from "../../ui";
import { plural } from "../../../state/browser/model";
import { updateSettings } from "../../../state/settings/actions";
import type { PasswordManager } from "../../../state/settings/settings";
import { SETTINGS_WINDOW_ID } from "../../../state/settings/settingsWindows";
import { unlockPasswordsFor } from "../../../state/site/savedPasswords";
import { iCloudPasswordsExtensionSupported } from "../../../state/site/passwords";
import { Group, Row, SectionHeader } from "../Form";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";

function managerOptions(): Option<PasswordManager>[] {
  return [
    ...(applePasswordsAvailable() ? [{ value: "apple" as const, title: "Apple Passwords (iCloud Keychain)" }] : []),
    { value: "ardia", title: "Ardia" },
    { value: "none", title: "Another password manager" },
  ];
}

export function PasswordManagerRow() {
  const mode = useEffectivePasswordManager();
  return (
    <Row anchor="profiles.passwordManager">
      <PopUp value={mode} options={managerOptions()} onChange={(passwordManager) => updateSettings({ passwordManager })} minWidth={210} />
    </Row>
  );
}

export const OTHER_MANAGER_DESCRIPTION: Record<Exclude<PasswordManager, "ardia">, string> = {
  apple: "Uses the macOS Passwords app and iCloud Keychain across your Apple devices.",
  none: "Built-in password prompts are off so your password manager extension can handle logins.",
};

export function ApplePasswordsDetails({ profile }: { profile: string }) {
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
        {iCloudPasswordsExtensionSupported() ? (
          <Row
            title="iCloud Passwords"
            description={extensionState === "enabled" ? "Paired with the macOS Passwords helper." : "Optional: pair with the iCloud Passwords extension from the Chrome Web Store."}
          >
            {extensionState !== "enabled" && <Button title={extensionState === "disabled" ? "Enable Extension" : "Add Extension…"} onPress={installOrEnableExtension} />}
          </Row>
        ) : null}
        <Row title="Filling a login" description="Click the Key button inside any username or password field, or right-click the field and choose AutoFill › Passwords, then approve with Touch ID." />
        <Row title="Verification codes" description="Click the Key button in a 2FA code field to fill a code from Passwords. Right-click a 2FA QR code on a page to add it to Passwords." />
        <Row title="Saving new logins" description="Ardia offers to open Passwords with the site and username copied when you sign in, or click + in Passwords anytime." />
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
