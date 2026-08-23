import { describe, expect, it } from "vitest";

import {
  mergeWorkOSRefresh,
  parseStoredTokenSnapshot,
  type WorkOSStoredTokens,
} from "../auth-session-record";

const current: WorkOSStoredTokens = {
  provider: "workos",
  accessToken: "access-current",
  refreshToken: "refresh-current",
  expiresAt: 1_700_000_300_000,
  sub: "user_example",
  email: "person@example.com",
  name: "Example Person",
  accountId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session_example",
  clientKind: "desktop",
  authenticationMethod: "GitHubOAuth",
};

describe("desktop auth safe-storage record", () => {
  it("reads the pre-WorkOS serialized shape as an Auth0 compatibility record", () => {
    const legacy = {
      accessToken: "legacy-access",
      refreshToken: "legacy-refresh",
      expiresAt: 1_700_000_300_000,
      sub: "auth0|example",
      email: "person@example.com",
      name: null,
    };
    expect(parseStoredTokenSnapshot(JSON.stringify(legacy))?.tokens).toEqual({
      ...legacy,
      provider: "auth0",
    });
  });

  it("rejects an incomplete WorkOS record instead of treating it as Auth0", () => {
    expect(
      parseStoredTokenSnapshot(
        JSON.stringify({ ...current, sessionId: undefined }),
      ),
    ).toBeNull();
  });

  it("persists every successful refresh response, including an unchanged refresh token", () => {
    expect(
      mergeWorkOSRefresh(current, {
        status: "active",
        session: {
          accessToken: "access-next",
          refreshToken: "refresh-current",
          expiresAt: 1_700_000_600_000,
          providerSubject: current.sub,
          sessionId: current.sessionId,
          clientKind: "desktop",
          email: "new@example.com",
          name: "New Name",
          authenticationMethod: "GoogleOAuth",
        },
      }),
    ).toEqual({
      status: "active",
      tokens: {
        ...current,
        accessToken: "access-next",
        refreshToken: "refresh-current",
        expiresAt: 1_700_000_600_000,
        email: "new@example.com",
        name: "New Name",
        authenticationMethod: "GoogleOAuth",
      },
    });
  });

  it("stores a post-rotation replacement while withholding an unverified bearer", () => {
    expect(
      mergeWorkOSRefresh(current, {
        status: "transient",
        reason: "verification_unavailable",
        replacementRefreshToken: "refresh-next",
      }),
    ).toEqual({
      status: "transient",
      tokens: { ...current, refreshToken: "refresh-next" },
    });
  });

  it("does not merge a verified response for another subject or session", () => {
    expect(
      mergeWorkOSRefresh(current, {
        status: "active",
        session: {
          accessToken: "access-next",
          refreshToken: "refresh-next",
          expiresAt: 1_700_000_600_000,
          providerSubject: "user_other",
          sessionId: current.sessionId,
          clientKind: "desktop",
          email: "other@example.com",
          name: null,
          authenticationMethod: null,
        },
      }),
    ).toEqual({ status: "transient", tokens: current });
  });
});
