import type { SessionData } from "./session";
export interface DashboardOrganization {
  id: string;
  slug: string;
  name: string;
  logo: string | null;
  role: "owner" | "admin" | "member";
  isPersonal: boolean;
  defaultTeamId: string | null;
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
  capabilities?: { createOrganization: boolean };
  organizations?: DashboardOrganization[];
  teams?: DashboardOrganization[];
}
export declare function organizationCreationAllowed(
  capabilities: DashboardMe["capabilities"] | null | undefined,
): boolean;
export declare function safeOrganizationLogo(value: unknown): string | null;
export declare function dashboardReturnUrl(
  appBase: string,
  requestUrl: string,
): string;
export declare function parseAccountRecoveryError(
  status: number,
  body: unknown,
): { recoveryCode: string | null } | null;
export type AccountResolutionError =
  | { kind: "recovery_required"; recoveryCode: string | null }
  | {
      kind:
        | "account_exists"
        | "reauthentication_required"
        | "account_unavailable";
    };
export declare function parseAccountResolutionError(
  status: number,
  body: unknown,
): AccountResolutionError | null;
export declare function accountAccessPage(input: {
  session: SessionData;
  kind: Exclude<AccountResolutionError["kind"], "recovery_required">;
  signOutHref: string;
}): string;
export declare function accountRecoveryPage(input: {
  session: SessionData;
  recoveryCode: string | null;
  signOutHref: string;
}): string;
export declare function accountDeletionPage(input: {
  session: SessionData;
  deletion: {
    id?: unknown;
    recoveryCode?: unknown;
    purgeAfter?: unknown;
    state?: unknown;
  };
  signOutHref: string;
}): string;
export declare function dashboardPage(input: {
  session: SessionData;
  me: DashboardMe | null;
  requestUrl: string;
  signOutHref: string;
  loadError?: string | null;
}): string;
