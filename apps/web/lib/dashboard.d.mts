import type { SessionData } from "./session";
export interface DashboardOrganization {
  id: string;
  slug: string;
  name: string;
  logo: string | null;
  role: "owner" | "admin" | "member";
  isPersonal: boolean;
  defaultTeamId: string;
  workspaceCapabilities: { local: true; cloud: boolean };
  teamCapabilities: { multiple: false; canCreate: false };
}
export interface DashboardMe {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl?: string | null;
  };
  organizations?: DashboardOrganization[];
  teams?: DashboardOrganization[];
}
export declare function safeOrganizationLogo(value: unknown): string | null;
export declare function dashboardReturnUrl(
  appBase: string,
  requestUrl: string,
): string;
export declare function dashboardPage(input: {
  session: SessionData;
  me: DashboardMe | null;
  requestUrl: string;
  signOutHref: string;
  loadError?: string | null;
}): string;
