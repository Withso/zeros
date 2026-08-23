export interface WorkOSDesktopSessionPage {
  data: Array<{ id: string; status: string }>;
  listMetadata: { after?: string | null };
}

export interface WorkOSDesktopManagementProvider {
  listSessions(
    subject: string,
    options: { limit: number; after?: string },
  ): Promise<WorkOSDesktopSessionPage>;
  revokeSession(sessionId: string): Promise<void>;
}

export function revokeWorkOSDesktopSessions(input: {
  scope: "current" | "all";
  subject: string;
  sessionId: string;
  provider: WorkOSDesktopManagementProvider;
}): Promise<{ revoked: number }>;

export function handleWorkOSDesktopRevocationRequest(
  request: Request,
  env: {
    AUTH_PROVIDER?: string;
    AUTH_SESSIONS?: DurableObjectNamespace;
  },
): Promise<Response>;
