// ──────────────────────────────────────────────────────────
// Cloud workspace links
// ──────────────────────────────────────────────────────────
//
// `zeros[-alpha|-beta|-dev]://cloud-workspace/<organizationId>/<workspaceId>`
// opens one cloud workspace in the desktop app and switches to its
// organization. The web workspace page (app.zeros.build/workspace/<id>) offers
// it as Open in Zeros; apps/web formats the same string without this package,
// and a root test keeps the two equal.
//
// The link carries the control plane's two UUIDs and nothing else. It grants
// nothing: the desktop reads the workspace as the signed-in account, and the
// control plane answers only its creator.
// ──────────────────────────────────────────────────────────

import {
  LOCAL_LINK_SCHEMES,
  formatWorkspaceAddress,
  isWorkspaceLinkOwner,
  isWorkspaceNumber,
  type LocalLinkScheme,
  type WorkspaceAddress,
} from "./local-orchestration";

export const CLOUD_WORKSPACE_LINK_ACTION = "cloud-workspace" as const;

export interface CloudWorkspaceLink {
  scheme: LocalLinkScheme;
  kind: typeof CLOUD_WORKSPACE_LINK_ACTION;
  organizationId: string;
  workspaceId: string;
}

// The renderer's cloud workspace key accepts the same UUIDs.
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const UUID_ONLY = new RegExp(`^${UUID}$`);
const LINK = new RegExp(`^(zeros(?:-alpha|-beta|-dev)?)://cloud-workspace/(${UUID})/(${UUID})$`);

export function formatCloudWorkspaceLink(
  scheme: LocalLinkScheme,
  target: { organizationId: string; workspaceId: string },
): string {
  if (!LOCAL_LINK_SCHEMES.includes(scheme)) throw new Error("Unknown Zeros link scheme.");
  if (!UUID_ONLY.test(target.organizationId) || !UUID_ONLY.test(target.workspaceId))
    throw new Error("Invalid cloud workspace for a link.");
  return `${scheme}://${CLOUD_WORKSPACE_LINK_ACTION}/${target.organizationId.toLowerCase()}/${target.workspaceId.toLowerCase()}`;
}

/** Parse exactly one link. Userinfo, a port, a query, a fragment, a trailing
 * slash, percent-encoding or an unknown scheme make it not a cloud link. */
export function parseCloudWorkspaceLink(text: string): CloudWorkspaceLink | null {
  const match = LINK.exec(text.trim());
  if (!match) return null;
  return {
    scheme: match[1] as LocalLinkScheme,
    kind: CLOUD_WORKSPACE_LINK_ACTION,
    organizationId: match[2]!.toLowerCase(),
    workspaceId: match[3]!.toLowerCase(),
  };
}

// A cloud workspace's shareable web page is addressed by its organization's
// slug and the workspace's permanent number: `app.zeros.build/<slug>/w/<n>`.
// The older `/workspace/<id>` page stays served. apps/web parses this path
// without importing this package; scripts/__tests__ keep the two equal.

/** Owner segments no organization's page uses: web routes, Local's own owner
 * and link actions. The control plane never gives a new organization one of
 * these slugs (its RESERVED_ORGANIZATION_SLUGS); an older organization that
 * has one keeps its `/workspace/<id>` page. */
export const RESERVED_WORKSPACE_LINK_OWNERS: readonly string[] = Object.freeze([
  "agents", "api", "assets", "auth", "chat", "cloud-workspace", "github",
  "invite", "local", "open", "personal", "schemas", "w", "workspace",
]);

/** Can this organization slug address a numbered workspace page? */
export function isCloudWorkspacePageOwner(owner: unknown): owner is string {
  return isWorkspaceLinkOwner(owner) && !RESERVED_WORKSPACE_LINK_OWNERS.includes(owner);
}

/** `/<organization slug>/w/<n>`. */
export function formatCloudWorkspacePagePath(address: WorkspaceAddress): string {
  return `/${formatWorkspaceAddress(address)}`;
}

/** The address a page path names, or null. Exactly `/<slug>/w/<n>`. */
export function parseCloudWorkspacePagePath(pathname: string): WorkspaceAddress | null {
  const match = /^\/([A-Za-z0-9-]{1,100})\/w\/([1-9][0-9]{0,9})$/.exec(pathname);
  if (!match) return null;
  const owner = match[1]!.toLowerCase();
  const number = Number(match[2]);
  return isCloudWorkspacePageOwner(owner) && isWorkspaceNumber(number) ? { owner, number } : null;
}
