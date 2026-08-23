export const WORKOS_FLOW_COOKIE: "__Host-zeros_auth_flow";
export const WORKOS_SESSION_COOKIE: "__Host-zeros_session";
export const WORKOS_FLOW_TTL_S: number;
export const WORKOS_SESSION_TTL_S: number;

export interface WorkOSSessionData {
  sub: string;
  email: string;
  name: string | null;
  accessToken: string;
  refreshToken: null;
  verifiedAt: number;
}

export interface WorkOSBrowserEnv {
  AUTH_PROVIDER?: string;
  APP_ORIGIN?: string;
  AUTH_SESSIONS?: DurableObjectNamespace;
}

export type WorkOSSessionRead = {
  sessionId: string;
  data: WorkOSSessionData;
  refreshStatus: "active" | "transient";
};

export type WorkOSRefreshResult =
  | { status: "active"; data: WorkOSSessionData }
  | {
      status: "transient";
      reason: string;
      retryAfter?: number;
      data?: WorkOSSessionData;
    }
  | { status: "terminal"; reason: string };

export function configuredAuthProvider(env: WorkOSBrowserEnv): "auth0" | "workos";
export function legacyDesktopHandoffEnabled(env: WorkOSBrowserEnv): boolean;
export function workosProvider(provider: string): "GoogleOAuth" | "GitHubOAuth" | null;
export function safeWorkOSReturnPath(raw: string | null, origin: string): string;
export function workosFlowCookie(opaqueId: string): string;
export function workosSessionCookie(opaqueId: string): string;
export function isWorkOSSessionId(value: string): boolean;
export function beginWorkOSBrowserAuth(
  request: Request,
  env: WorkOSBrowserEnv,
  options?: { randomId?: () => string },
): Promise<Response>;
export function finishWorkOSBrowserAuth(
  request: Request,
  env: WorkOSBrowserEnv,
): Promise<Response>;
export function readWorkOSBrowserSession(
  env: WorkOSBrowserEnv,
  request: Request,
): Promise<WorkOSSessionRead | null>;
export function refreshWorkOSBrowserSession(
  env: WorkOSBrowserEnv,
  sessionId: string,
): Promise<WorkOSRefreshResult>;
export function logoutWorkOSBrowserSession(
  request: Request,
  env: WorkOSBrowserEnv,
): Promise<Response>;
