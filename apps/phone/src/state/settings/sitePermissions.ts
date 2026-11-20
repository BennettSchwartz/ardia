import { create } from "zustand";
import { pages, type SitePermissionGrant, type SitePermissionKind } from "../../platform/pages";
import { settled } from "../pages/store";
import { countUsage } from "../telemetry/telemetry";

type SitePermissionsState = { listed: boolean; grants: SitePermissionGrant[] };

export const useSitePermissions = create<SitePermissionsState>()(() => ({ listed: false, grants: [] }));

export async function refreshSitePermissions() {
  const listed = await settled(async () => pages.listsSitePermissions(), false);
  if (!listed) return;
  const grants = await settled(() => pages.sitePermissions(), null);
  if (grants) useSitePermissions.setState({ listed: true, grants });
}

export async function revokeSiteAccess(origin: string, permission?: SitePermissionKind) {
  const revoked = await pages.revokeSitePermission(origin, permission);
  if (revoked) countUsage("site_permissions_revoked");
  await refreshSitePermissions();
}
