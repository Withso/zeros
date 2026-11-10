import { formatCloudWorkspacePagePath } from "@zeros/protocol/cloud-workspace-link";
import { isWorkspaceLinkSession, type WorkspaceAddress } from "@zeros/protocol/local-orchestration";
const DEFAULT_APP_BASE_URL = "https://app.zeros.build";

/** This channel's web app; each release build sets its own origin. */
export const APP_BASE_URL =
  (import.meta.env.VITE_APP_BASE_URL as string | undefined) ||
  DEFAULT_APP_BASE_URL;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The configured web origin, never a non-web scheme from build configuration. */
function appOrigin(appBaseUrl: string | null | undefined): URL {
  let base: URL;
  try {
    base = new URL(appBaseUrl?.trim() || DEFAULT_APP_BASE_URL);
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new Error("Dashboard URL must use HTTP(S)");
    }
  } catch {
    base = new URL(DEFAULT_APP_BASE_URL);
  }
  base.pathname = "/";
  base.search = "";
  base.hash = "";
  return base;
}

export function organizationDashboardUrl(
  appBaseUrl: string | null | undefined,
  options: {
    organizationId?: string;
    section?: "general" | "members" | "teams" | "billing" | "profile";
    action?: "create-organization";
  } = {},
): string {
  const base = appOrigin(appBaseUrl);
  if (options.organizationId) {
    base.searchParams.set("organization", options.organizationId);
  }
  if (options.section) base.searchParams.set("section", options.section);
  if (options.action) base.searchParams.set("action", options.action);
  return base.toString();
}

/** A cloud workspace's shareable page by its organization's slug and its
 * permanent number: `<app>/<slug>/w/<n>`, and a chat in it with
 * `?session=<chat id>`, the query its desktop link carries too. */
export function numberedCloudWorkspacePageUrl(
  appBaseUrl: string | null | undefined,
  address: WorkspaceAddress,
  session?: string | null,
): string {
  const base = appOrigin(appBaseUrl);
  base.pathname = formatCloudWorkspacePagePath(address);
  if (session != null) {
    if (!isWorkspaceLinkSession(session)) throw new Error("Invalid chat id for a link.");
    base.search = `?session=${encodeURIComponent(session)}`;
  }
  return base.toString();
}

/** A cloud workspace's web page by id (the older form), which offers Open in Zeros. */
export function cloudWorkspacePageUrl(
  appBaseUrl: string | null | undefined,
  workspaceId: string,
): string {
  if (!UUID.test(workspaceId)) throw new Error("Invalid cloud workspace id");
  const base = appOrigin(appBaseUrl);
  base.pathname = `/workspace/${workspaceId.toLowerCase()}`;
  return base.toString();
}
