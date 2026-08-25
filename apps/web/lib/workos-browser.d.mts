export const WORKOS_FLOW_COOKIE: "__Host-zeros_auth_flow";
export const WORKOS_SESSION_COOKIE: "__Host-zeros_session";

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
  CONTROL_PLANE_URL?: string;
}

export type WorkOSSessionRead = {
  sessionId: string;
  data: WorkOSSessionData;
  refreshStatus: "active" | "transient";
  revision: number;
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
export function beginWorkOSBrowserAuth(
  request: Request,
  env: WorkOSBrowserEnv,
  options?: { fetch?: typeof fetch },
): Promise<Response>;
export function finishWorkOSBrowserAuth(
  request: Request,
  env: WorkOSBrowserEnv,
  options?: { fetch?: typeof fetch },
): Promise<Response>;
export function readWorkOSBrowserSession(
  env: WorkOSBrowserEnv,
  request: Request,
  options?: { fetch?: typeof fetch },
): Promise<WorkOSSessionRead | null>;
export function refreshWorkOSBrowserSession(
  env: WorkOSBrowserEnv,
  sessionId: string,
  expectedRevision?: number,
  options?: { fetch?: typeof fetch },
): Promise<WorkOSRefreshResult>;
export function logoutWorkOSBrowserSession(
  request: Request,
  env: WorkOSBrowserEnv,
  options?: { fetch?: typeof fetch },
): Promise<Response>;
