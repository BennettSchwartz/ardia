import { PLATFORM_FEATURES } from "../../../lib/platformFeatures";
import { usePlugins } from "../../../state/plugins/store";
import { choicePlugin, type ManagerPlugin, type PasswordManagerChoice } from "../../../state/site/passwordManagerChoice";
import { choosePasswordManager, useManagerPlugins, useProfilePasswordManager, useProfilesSharingChoice, useStoredPasswordManager } from "../../../state/site/passwordManager";
import { type Option, PopUp } from "../../ui";
import { Row } from "../Form";

function managerOptions(plugins: readonly ManagerPlugin[]): Option<PasswordManagerChoice>[] {
  return [
    { value: "ardia", title: "Ardia" },
    ...plugins.map((p) => ({ value: `plugin:${p.name}` as PasswordManagerChoice, title: p.title })),
    { value: "none", title: "None (an extension handles logins)", separatorBefore: true },
  ];
}

function sharedChoiceNote(names: string[]): string | null {
  if (!names.length) return null;
  const others = names.length === 1 ? names[0]! : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;
  return `Also applies to ${others}, which ${names.length === 1 ? "shares" : "share"} this profile's browser data.`;
}

function useUnavailableNote(stored: PasswordManagerChoice | undefined, effective: PasswordManagerChoice): string | null {
  const name = stored ? choicePlugin(stored) : null;
  const title = usePlugins((p) => (name ? (p.listings[name]?.manifest?.title ?? name) : null));
  if (!name || stored === effective) return null;
  return `${title} is off, so this profile uses Ardia until you turn it back on in Plugins.`;
}

export function PasswordManagerRow({ profileId }: { profileId: string }) {
  return PLATFORM_FEATURES.systemPasswordManagers && PLATFORM_FEATURES.plugins ? <PasswordManagerChoiceRow profileId={profileId} /> : null;
}

function PasswordManagerChoiceRow({ profileId }: { profileId: string }) {
  const plugins = useManagerPlugins();
  const effective = useProfilePasswordManager(profileId);
  const stored = useStoredPasswordManager(profileId);
  const sharing = useProfilesSharingChoice(profileId);
  const unavailable = useUnavailableNote(stored, effective);
  const description = [unavailable, sharedChoiceNote(sharing)].filter(Boolean).join(" ") || undefined;
  return (
    <Row anchor="profiles.passwordManager" description={description}>
      <PopUp value={effective} options={managerOptions(plugins)} onChange={(manager) => choosePasswordManager(profileId, manager)} minWidth={210} />
    </Row>
  );
}

export function offerToSaveHandedOver(effective: PasswordManagerChoice, plugins: readonly ManagerPlugin[]): string | null {
  if (effective === "ardia") return null;
  if (effective === "none") return "Your password manager extension handles logins in this profile, so Ardia doesn't offer to save them.";
  const plugin = plugins.find((p) => `plugin:${p.name}` === effective);
  return `${plugin?.title ?? "Another password manager"} handles logins in this profile, so Ardia doesn't offer to save them. Logins already saved in Ardia still fill.`;
}
