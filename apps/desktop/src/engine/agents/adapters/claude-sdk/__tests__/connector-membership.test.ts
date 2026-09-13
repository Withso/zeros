import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClaudeConnectorMembershipReader,
  parseClaudeConnectorMembership,
  readClaudeConnectorCredential,
  selectClaudeSessionConnectors,
} from "../connector-membership";
import { defaultMacClaudeOAuthAuthority } from "../../../containment/claude-oauth-authority";

vi.mock("../../../containment/claude-oauth-authority", () => ({
  defaultMacClaudeOAuthAuthority: vi.fn().mockReturnValue(null),
}));

const connected = (id: string) => ({
  id,
  eligible: true,
  eligibility_reason: "connected",
});
const unconnected = (id: string) => ({
  id,
  eligible: false,
  eligibility_reason: "never_connected_no_auto_connect",
});
const catalog = (data: unknown[], next_page: unknown = null) => ({
  data,
  next_page,
});
const response = (data: unknown[], nextPage: unknown = null) =>
  Response.json(catalog(data, nextPage));
const cloud = (id: string, status: "connected" | "failed" | "needs-auth") => ({
  name: id,
  status,
  scope: "claudeai",
  config: {
    type: "claudeai-proxy" as const,
    id,
    url: "https://example.com/mcp",
  },
});

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(defaultMacClaudeOAuthAuthority).mockReset().mockReturnValue(null);
});

describe("Claude account connector membership", () => {
  it("separates membership from eligibility and drops unrelated provider data", () => {
    const result = parseClaudeConnectorMembership(
      catalog([
        {
          ...connected("enabled"),
          display_name: "PRIVATE",
          url: "SECRET",
          tools: ["SECRET"],
        },
        unconnected("catalogue"),
        { id: "expired", eligible: false, eligibility_reason: "connected" },
      {
        id: "unknown",
        eligible: false,
        eligibility_reason: "new_provider_reason",
      },
      {
        id: "eligible-only",
        eligible: true,
        eligibility_reason: "new_provider_reason",
      },
      ]),
    );
    expect([...result.memberships]).toEqual([
      ["enabled", "connected"],
      ["catalogue", "not-connected"],
      ["expired", "connected"],
    ]);
    expect(result.complete).toBe(false);
    expect(JSON.stringify([...result.memberships])).not.toMatch(
      /SECRET|PRIVATE/,
    );
  });

  it("treats malformed rows, duplicate identities, pagination and oversized lists as partial", () => {
    expect(() => parseClaudeConnectorMembership({ error: "SECRET" })).toThrow(
      "unavailable",
    );
    const duplicated = parseClaudeConnectorMembership(
      catalog([
        connected("duplicate"),
        unconnected("duplicate"),
        connected("duplicate"),
        null,
      ]),
    );
    expect(duplicated.complete).toBe(false);
    expect(duplicated.memberships.has("duplicate")).toBe(false);
    expect(
      parseClaudeConnectorMembership(catalog([], "next-cursor")).complete,
    ).toBe(false);
    const oversized = parseClaudeConnectorMembership(
      catalog(Array.from({ length: 1_001 }, (_, i) => connected(String(i)))),
    );
    expect(oversized.complete).toBe(false);
    expect(oversized.memberships.size).toBe(1_000);
  });

  it("deduplicates concurrent reads and revalidates membership on every refresh", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([connected("service")]))
      .mockResolvedValueOnce(response([unconnected("service")]));
    const read = createClaudeConnectorMembershipReader(
      {},
      new AbortController().signal,
      {
        readCredential: vi.fn().mockResolvedValue("test-access"),
        fetch: fetcher,
      },
    );
    const first = read();
    expect(read()).toBe(first);
    expect((await first).memberships.get("service")).toBe("connected");
    expect((await read()).memberships.get("service")).toBe("not-connected");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toMatchObject([
      "https://api.anthropic.com/v1/mcp_servers?limit=1000",
      {
        redirect: "error",
        headers: {
          Authorization: "Bearer test-access",
          "anthropic-beta": "mcp-servers-2025-12-04",
        },
      },
    ]);
  });

  it("preserves only this query's membership through failure, then accepts a fresh disconnect", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response([connected("known"), unconnected("catalogue")]),
      )
      .mockRejectedValueOnce(new Error("SECRET"))
      .mockResolvedValueOnce(
        response([unconnected("known"), unconnected("catalogue")]),
      );
    const deps = {
      readCredential: vi.fn().mockResolvedValue("test-access"),
      fetch: fetcher,
    };
    const read = createClaudeConnectorMembershipReader(
      {},
      new AbortController().signal,
      deps,
    );
    const statuses = [
      cloud("known", "failed"),
      cloud("catalogue", "needs-auth"),
    ];
    expect(
      (await selectClaudeSessionConnectors(statuses, read)).servers,
    ).toHaveLength(1);
    const failed = await selectClaudeSessionConnectors(statuses, read);
    expect(failed).toEqual({ servers: [statuses[0]], partial: true });
    expect(
      (await selectClaudeSessionConnectors(statuses, read)).servers,
    ).toEqual([]);
    const other = createClaudeConnectorMembershipReader(
      {},
      new AbortController().signal,
      {
        ...deps,
        fetch: vi.fn().mockRejectedValue(new Error("SECRET")),
      },
    );
    expect(
      (await selectClaudeSessionConnectors(statuses, other)).servers,
    ).toEqual([]);
  });

  it("retains a runtime-confirmed connector if a later transport failure overlaps an account outage", async () => {
    const read = createClaudeConnectorMembershipReader(
      {},
      new AbortController().signal,
      {
        readCredential: vi.fn().mockResolvedValue("test-access"),
        fetch: vi.fn().mockRejectedValue(new Error("offline")),
      },
    );
    await selectClaudeSessionConnectors([cloud("known", "connected")], read);
    const failed = cloud("known", "failed");
    expect(
      await selectClaudeSessionConnectors(
        [failed, cloud("catalogue", "needs-auth")],
        read,
      ),
    ).toEqual({ servers: [failed], partial: true });
  });

  it("captures the selected profile and never uses an ambient credential for explicit auth", async () => {
    const readCredential = vi.fn().mockResolvedValue("test-access");
    const fetcher = vi.fn().mockImplementation(async () => response([]));
    const env = { HOME: "/account-home", CLAUDE_CONFIG_DIR: "/profiles/first" };
    const read = createClaudeConnectorMembershipReader(
      env,
      new AbortController().signal,
      { readCredential, fetch: fetcher },
    );
    env.CLAUDE_CONFIG_DIR = "/profiles/second";
    await read();
    expect(readCredential.mock.calls[0][0]).toEqual({
      HOME: "/account-home",
      CLAUDE_CONFIG_DIR: "/profiles/first",
    });
    readCredential.mockClear();
    for (const explicit of [
      { ANTHROPIC_API_KEY: "test-key" },
      { CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
      { ANTHROPIC_BASE_URL: "https://example.com" },
    ]) {
      const blocked = createClaudeConnectorMembershipReader(
        explicit,
        new AbortController().signal,
        { readCredential, fetch: fetcher },
      );
      expect((await blocked()).complete).toBe(false);
    }
    expect(readCredential).not.toHaveBeenCalled();
  });

  it("bounds stalled reads and cancels network work with the query", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => new Promise(() => {}));
    const query = new AbortController();
    const read = createClaudeConnectorMembershipReader({}, query.signal, {
      readCredential: vi.fn().mockResolvedValue("test-access"),
      fetch: fetcher,
    });
    const pending = read();
    await vi.advanceTimersByTimeAsync(0);
    query.abort();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).complete).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await read();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized responses and unknown response shapes without leaking provider errors", async () => {
    for (const result of [
      new Response("SECRET", { status: 403 }),
      Response.json({ error: "SECRET" }),
      new Response(" ".repeat(8 * 1024 * 1024 + 1)),
    ]) {
      const read = createClaudeConnectorMembershipReader(
        {},
        new AbortController().signal,
        {
          readCredential: vi.fn().mockResolvedValue("test-access"),
          fetch: vi.fn().mockResolvedValue(result),
        },
      );
      expect(await read()).toEqual({ memberships: new Map(), complete: false });
    }
  });
});

describe("Claude connector credential scope", () => {
  it("reads the chosen native profile and never falls back to a different account", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-connector-credential-"),
    );
    try {
      const selected = path.join(root, "selected");
      const ambient = path.join(root, ".claude");
      await Promise.all([mkdir(selected), mkdir(ambient)]);
      const credential = (token: string) =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: token,
            scopes: ["user:mcp_servers"],
            expiresAt: Date.now() + 60_000,
          },
        });
      await writeFile(
        path.join(ambient, ".credentials.json"),
        credential("other-account"),
      );
      const env = { HOME: root, CLAUDE_CONFIG_DIR: selected };
      const signal = new AbortController().signal;
      await expect(
        readClaudeConnectorCredential(env, signal),
      ).rejects.toThrow();
      await writeFile(
        path.join(selected, ".credentials.json"),
        credential("selected-account"),
      );
      expect(await readClaudeConnectorCredential(env, signal)).toBe(
        "selected-account",
      );
      vi.mocked(defaultMacClaudeOAuthAuthority).mockReturnValue({
        readProjectedCredential: vi
          .fn()
          .mockResolvedValue({ status: "unavailable" }),
      } as never);
      expect(await readClaudeConnectorCredential(env, signal)).toBeNull();
      expect(defaultMacClaudeOAuthAuthority).toHaveBeenLastCalledWith(
        root,
        selected,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
