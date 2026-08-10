const DEFAULT_APP_BASE_URL = "https://app.zeros.build";

export function organizationDashboardUrl(
  appBaseUrl: string | null | undefined,
  options: {
    organizationId?: string;
    section?: "general" | "members" | "teams" | "billing" | "profile";
    action?: "create-organization";
  } = {},
): string {
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
  if (options.organizationId) {
    base.searchParams.set("organization", options.organizationId);
  }
  if (options.section) base.searchParams.set("section", options.section);
  if (options.action) base.searchParams.set("action", options.action);
  return base.toString();
}
