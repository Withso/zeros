import type { WorkOSSessionData } from "./workos-browser.mjs";

export type WorkOSUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
};

export type WorkOSExchange = {
  sealedSession: string;
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  user: WorkOSUser;
};

export type WorkOSFlowRecord = {
  kind: "flow";
  state: string;
  codeVerifier: string;
  returnPath: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  claimedAt: number | null;
};

export type WorkOSSessionRecord = {
  kind: "session";
  sealedSession: string;
  sessionId: string;
  accessTokenExpiresAt: number;
  sessionExpiresAt: number;
  revision: number;
  data: WorkOSSessionData;
};

export type WorkOSCoordinatorRecord = WorkOSFlowRecord | WorkOSSessionRecord;

export interface WorkOSCoordinatorStorage {
  getRecord(): Promise<WorkOSCoordinatorRecord | null>;
  putRecord(record: WorkOSCoordinatorRecord): Promise<void>;
  claimFlow(state: string, now: number): Promise<WorkOSFlowRecord | null>;
  deleteAll(): Promise<void>;
  setExpiry(epochMs: number): Promise<void>;
}

export interface WorkOSCoordinatorProvider {
  authorizationUrl(options: {
    provider: string;
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string;
  exchange(options: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<WorkOSExchange>;
  refresh(options: { sealedSession: string }): Promise<
    | ({ status: "active" } & WorkOSExchange)
    | {
        status: "transient";
        reason: string;
        retryAfter?: number;
        /** Present only when WorkOS already rotated successfully and a later
         * local verification step failed. */
        sealedSession?: string;
      }
    | { status: "terminal"; reason: string }
  >;
  logoutUrl(options: { sessionId: string; returnTo: string }): string;
}

export type WorkOSCoordinatorSessionResult =
  | { status: "active"; data: WorkOSSessionData }
  | {
      status: "transient";
      reason: string;
      retryAfter?: number;
      data: WorkOSSessionData;
    }
  | { status: "terminal"; reason: string };

export class WorkOSSessionCoordinator {
  constructor(options: {
    storage: WorkOSCoordinatorStorage;
    provider: WorkOSCoordinatorProvider;
    now?: () => number;
    randomToken: () => string;
    pkceChallenge: (verifier: string) => Promise<string>;
  });
  startFlow(options: {
    provider: string;
    returnPath: string;
    redirectUri: string;
  }): Promise<{ authorizationUrl: string }>;
  completeFlow(options: {
    code: string;
    state: string;
  }): Promise<
    | { ok: true; returnPath: string }
    | { ok: false; reason: string }
  >;
  cancelFlow(): Promise<void>;
  getSession(): Promise<WorkOSCoordinatorSessionResult>;
  refreshSession(): Promise<WorkOSCoordinatorSessionResult>;
  logout(returnTo: string): Promise<{ logoutUrl: string | null }>;
}
