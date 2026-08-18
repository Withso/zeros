import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ClaudeOAuthAuthority,
  requestClaudeOAuthRefresh,
  withMacClaudeRefreshLock,
  type ClaudeCredentialReadResult,
} from "../claude-oauth-authority";

function credential(options: {
  access: string;
  refresh: string;
  expiresAt: number;
}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: options.access,
      refreshToken: options.refresh,
      expiresAt: options.expiresAt,
      scopes: ["user:inference"],
      subscriptionType: "max",
    },
    mcpOAuth: { retained: true },
  });
}

describe("Claude OAuth host authority", () => {
  it("recovers an empty stale refresh lock left by a crashed writer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-claude-lock-test-"));
    const lockRoot = path.join(root, "credentials");
    const lockPath = path.join(lockRoot, "claude-oauth-refresh.lock");
    try {
      await mkdir(lockRoot, { recursive: true, mode: 0o700 });
      await writeFile(lockPath, "", { mode: 0o600, flag: "wx" });
      const stale = new Date(Date.now() - 61_000);
      await utimes(lockPath, stale, stale);

      await expect(
        withMacClaudeRefreshLock(async () => "recovered", { lockRoot }),
      ).resolves.toBe("recovered");
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("single-flights an expired rotating refresh and never projects the refresh token", async () => {
    const now = 1_800_000_000_000;
    let stored = credential({
      access: "expired-access",
      refresh: "single-use-refresh",
      expiresAt: now - 1,
    });
    const refreshToken = vi.fn(async () => ({
      accessToken: "fresh-access",
      refreshToken: "rotated-refresh",
      expiresIn: 28_800,
    }));
    const commitCredential = vi.fn(async (_previous: string, next: string) => {
      stored = next;
      return stored;
    });
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async (): Promise<ClaudeCredentialReadResult> => ({
        status: "available",
        value: stored,
      }),
      refreshToken,
      commitCredential,
    });

    const [first, second] = await Promise.all([
      authority.readProjectedCredential(),
      authority.readProjectedCredential(),
    ]);

    expect(refreshToken).toHaveBeenCalledOnce();
    expect(refreshToken).toHaveBeenCalledWith(
      "single-use-refresh",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(commitCredential).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(first.status).toBe("available");
    if (first.status !== "available") throw new Error("credential unavailable");
    expect(JSON.parse(first.value)).toEqual({
      claudeAiOauth: {
        accessToken: "fresh-access",
        expiresAt: now + 28_800_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
      mcpOAuth: { retained: true },
    });
    expect(first.value).not.toContain("single-use-refresh");
    expect(first.value).not.toContain("rotated-refresh");
    expect(JSON.parse(stored).claudeAiOauth.refreshToken).toBe(
      "rotated-refresh",
    );
  });

  it("uses a changed host credential when another process wins a refresh race", async () => {
    const now = 1_800_000_000_000;
    const original = credential({
      access: "old-access",
      refresh: "old-refresh",
      expiresAt: now - 1,
    });
    const winner = credential({
      access: "winner-access",
      refresh: "winner-refresh",
      expiresAt: now + 28_800_000,
    });
    let reads = 0;
    const refreshToken = vi.fn(async () => {
      throw new Error("response body containing old-refresh");
    });
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async () => ({
        status: "available" as const,
        // Initial observation + locked re-read still see the old rotating
        // token. Only the recovery re-read observes the external winner.
        value: reads++ < 2 ? original : winner,
      }),
      refreshToken,
      commitCredential: async () => {
        throw new Error("must not commit a losing refresh");
      },
    });

    await expect(
      authority.getAccessToken({ forceRefresh: true }),
    ).resolves.toBe("winner-access");
    expect(refreshToken).toHaveBeenCalledOnce();
  });

  it("does not consume a rotating token when the caller was already cancelled", async () => {
    const now = 1_800_000_000_000;
    const stored = credential({
      access: "expired-access",
      refresh: "unused-refresh",
      expiresAt: now - 1,
    });
    const refreshToken = vi.fn(async () => ({
      accessToken: "must-not-be-used",
      refreshToken: "must-not-be-rotated",
      expiresIn: 28_800,
    }));
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async () => ({ status: "available", value: stored }),
      refreshToken,
      commitCredential: async () => stored,
    });
    const abort = new AbortController();
    abort.abort();

    await expect(
      authority.getAccessToken({ forceRefresh: true, signal: abort.signal }),
    ).rejects.toThrow("Claude OAuth credential refresh was cancelled");
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("does not let a cancelled caller poison a simultaneous valid refresh", async () => {
    const now = 1_800_000_000_000;
    let stored = credential({
      access: "expired-access",
      refresh: "single-use-refresh",
      expiresAt: now - 1,
    });
    const refreshToken = vi.fn(async () => ({
      accessToken: "fresh-access",
      refreshToken: "rotated-refresh",
      expiresIn: 28_800,
    }));
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async () => ({ status: "available", value: stored }),
      refreshToken,
      commitCredential: async (_previous, next) => {
        stored = next;
        return stored;
      },
    });
    const cancelled = new AbortController();
    cancelled.abort();

    const [cancelledResult, validResult] = await Promise.allSettled([
      authority.getAccessToken({
        forceRefresh: true,
        signal: cancelled.signal,
      }),
      authority.getAccessToken({ forceRefresh: true }),
    ]);

    expect(cancelledResult).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "Claude OAuth credential refresh was cancelled",
      }),
    });
    expect(validResult).toEqual({ status: "fulfilled", value: "fresh-access" });
    expect(refreshToken).toHaveBeenCalledOnce();
  });

  it("keeps serving a still-valid access token when the proactive refresh fails", async () => {
    const now = 1_800_000_000_000;
    // Inside the 5-minute proactive-refresh skew but not actually expired.
    const stored = credential({
      access: "still-valid-access",
      refresh: "consumed-elsewhere",
      expiresAt: now + 2 * 60_000,
    });
    const refreshToken = vi.fn(async () => {
      throw new Error("Claude OAuth refresh request was rejected");
    });
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async () => ({ status: "available", value: stored }),
      refreshToken,
      commitCredential: async () => stored,
    });

    const projected = await authority.readProjectedCredential();
    expect(projected.status).toBe("available");
    if (projected.status !== "available") throw new Error("unavailable");
    expect(JSON.parse(projected.value).claudeAiOauth.accessToken).toBe(
      "still-valid-access",
    );
    expect(projected.value).not.toContain("consumed-elsewhere");
    await expect(authority.getAccessToken()).resolves.toBe(
      "still-valid-access",
    );
  });

  it("still fails admission when the access token is truly expired and refresh is rejected", async () => {
    const now = 1_800_000_000_000;
    const stored = credential({
      access: "dead-access",
      refresh: "dead-refresh",
      expiresAt: now - 1,
    });
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async () => ({ status: "available", value: stored }),
      refreshToken: async () => {
        throw new Error("Claude OAuth refresh request was rejected");
      },
      commitCredential: async () => stored,
    });

    await expect(authority.readProjectedCredential()).rejects.toThrow(
      "Claude OAuth refresh request was rejected",
    );
  });

  it("does not fall back to the stored token when the caller proved it dead", async () => {
    const now = 1_800_000_000_000;
    const stored = credential({
      access: "provider-rejected-access",
      refresh: "some-refresh",
      expiresAt: now + 60 * 60_000,
    });
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async () => ({ status: "available", value: stored }),
      refreshToken: async () => {
        throw new Error("Claude OAuth refresh request was rejected");
      },
      commitCredential: async () => stored,
    });

    await expect(
      authority.getAccessToken({ forceRefresh: true }),
    ).rejects.toThrow("Claude OAuth refresh request was rejected");
  });

  it("retries one transient refresh failure before surfacing it", async () => {
    const now = 1_800_000_000_000;
    let stored = credential({
      access: "expired-access",
      refresh: "still-valid-refresh",
      expiresAt: now - 1,
    });
    const refreshToken = vi
      .fn(async () => ({
        accessToken: "fresh-access",
        refreshToken: "rotated-refresh",
        expiresIn: 28_800,
      }))
      .mockRejectedValueOnce(new Error("Claude OAuth refresh request failed"));
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async () => ({ status: "available", value: stored }),
      refreshToken,
      commitCredential: async (_previous, next) => {
        stored = next;
        return stored;
      },
    });

    await expect(
      authority.getAccessToken({ forceRefresh: true }),
    ).resolves.toBe("fresh-access");
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(JSON.parse(stored).claudeAiOauth.refreshToken).toBe(
      "rotated-refresh",
    );
  });

  it("does not retry a definitive refresh rejection", async () => {
    const now = 1_800_000_000_000;
    const stored = credential({
      access: "expired-access",
      refresh: "revoked-refresh",
      expiresAt: now - 1,
    });
    const refreshToken = vi.fn(async () => {
      throw new Error("Claude OAuth refresh request was rejected");
    });
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async () => ({ status: "available", value: stored }),
      refreshToken,
      commitCredential: async () => stored,
    });

    await expect(
      authority.getAccessToken({ forceRefresh: true }),
    ).rejects.toThrow("Claude OAuth refresh request was rejected");
    expect(refreshToken).toHaveBeenCalledOnce();
  });

  it("classifies only definitive statuses as rejection and the rest as transient", async () => {
    const failingFetch = (status: number) =>
      vi.fn(async () =>
        Promise.resolve(
          new Response("{}", {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    await expect(
      requestClaudeOAuthRefresh("token", {
        fetchImpl: failingFetch(401) as typeof fetch,
      }),
    ).rejects.toThrow("Claude OAuth refresh request was rejected");
    await expect(
      requestClaudeOAuthRefresh("token", {
        fetchImpl: failingFetch(429) as typeof fetch,
      }),
    ).rejects.toThrow("Claude OAuth refresh request failed");
    await expect(
      requestClaudeOAuthRefresh("token", {
        fetchImpl: failingFetch(529) as typeof fetch,
      }),
    ).rejects.toThrow("Claude OAuth refresh request failed");
  });

  it("returns value-free errors when refresh fails without a concurrent winner", async () => {
    const now = 1_800_000_000_000;
    const secret = "refresh-secret-that-must-not-escape";
    const stored = credential({
      access: "expired-access",
      refresh: secret,
      expiresAt: now - 1,
    });
    const authority = new ClaudeOAuthAuthority({
      now: () => now,
      readCredential: async () => ({ status: "available", value: stored }),
      refreshToken: async () => {
        throw new Error(`provider rejected ${secret}`);
      },
      commitCredential: async () => stored,
    });

    let failure: unknown;
    try {
      await authority.getAccessToken({ forceRefresh: true });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error))
      throw new Error("expected refresh failure");
    expect(failure.message).toBe("Claude OAuth refresh provider failed");
    expect(failure.message).not.toContain(secret);
  });

  it("posts the exact pinned OAuth contract with bounded, validated JSON", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.credentials).toBe("omit");
      expect(init?.headers).toMatchObject({
        Accept: "application/json",
        "Content-Type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-input",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      });
      return new Response(
        JSON.stringify({
          access_token: "access-output",
          refresh_token: "refresh-output",
          expires_in: 28_800,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      requestClaudeOAuthRefresh("refresh-input", {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({
      accessToken: "access-output",
      refreshToken: "refresh-output",
      expiresIn: 28_800,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://platform.claude.com/v1/oauth/token",
      expect.any(Object),
    );
  });

  it("rejects oversized and malformed refresh responses without reading secrets into errors", async () => {
    const oversized = vi.fn(async () =>
      Promise.resolve(
        new Response("x".repeat(70_000), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(
      requestClaudeOAuthRefresh("hidden-refresh", {
        fetchImpl: oversized as typeof fetch,
      }),
    ).rejects.toThrow("Claude OAuth refresh response exceeded its size limit");

    const malformed = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: "only-access" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(
      requestClaudeOAuthRefresh("hidden-refresh", {
        fetchImpl: malformed as typeof fetch,
      }),
    ).rejects.toThrow("Claude OAuth refresh response was invalid");
  });
});
