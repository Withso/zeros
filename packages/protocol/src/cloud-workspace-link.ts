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

import { LOCAL_LINK_SCHEMES, type LocalLinkScheme } from "./local-orchestration";

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
