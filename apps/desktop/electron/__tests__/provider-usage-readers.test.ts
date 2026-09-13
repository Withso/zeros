import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readClaudeUsage,
  readCursorUsage,
  readUsageJson,
} from "../provider-usage-readers";
import { claudeCredentialKeychainService } from "../../src/engine/agents/containment/claude-oauth-authority";

afterEach(() => vi.unstubAllGlobals());
describe("native usage readers", () => {
  it("pins Claude profile and quota to the same token even if the CLI changes accounts", async () => {
    let token = "fixture-a";
    const readToken = vi.fn(async () => token);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(init.headers).toMatchObject({
          Authorization: "Bearer fixture-a",
        });
        token = "fixture-b";
        return Response.json(
          url.endsWith("/profile")
            ? {
                account: { email: "a@example.test" },
                organization: { name: "Example team" },
                privateData: "excluded",
              }
            : { seven_day: { utilization: 25 } },
        );
      }),
    );
    expect(
      await readClaudeUsage("/profile", AbortSignal.timeout(1000), readToken),
    ).toEqual({
      windows: [{ id: "weekly", usedPercent: 25 }],
      identity: JSON.stringify(["a@example.test", "Example team"]),
    });
    expect(readToken).toHaveBeenCalledOnce();
  });

  it("does not return Claude quota without a confirmed identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ seven_day: { utilization: 25 } })),
    );
    await expect(
      readClaudeUsage(
        "/profile",
        AbortSignal.timeout(1000),
        async () => "fixture-token",
      ),
    ).rejects.toThrow("identity unavailable");
  });
  it("uses separate Claude keychain namespaces for every explicit profile", () => {
    expect(claudeCredentialKeychainService()).toBe("Claude Code-credentials");
    const first = claudeCredentialKeychainService("/owned/account-a");
    const second = claudeCredentialKeychainService("/owned/account-b");
    expect(first).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
    expect(claudeCredentialKeychainService("/Users/fixture/.claude")).not.toBe(
      claudeCredentialKeychainService(),
    );
  });
  it("reads Cursor pools and plan using only the selected credential and fixed native endpoints", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      if (url.endsWith("exchange_user_api_key")) {
        expect(init.headers).toMatchObject({
          Authorization: "Bearer fixture-key",
        });
        return Response.json({ accessToken: "fixture-access-token" });
      }
      expect(init.headers).toMatchObject({
        Authorization: "Bearer fixture-access-token",
      });
      if (url.endsWith("GetMe"))
        return Response.json({ teamId: 7, teamName: "Example team" });
      if (url.endsWith("full_stripe_profile"))
        return Response.json({
          membershipType: "pro",
          privateBillingData: "excluded",
        });
      expect(url).toBe(
        "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      );
      expect(JSON.parse(init.body as string)).toEqual({
        teamId: 7,
        includePooledUsage: true,
      });
      return Response.json({
        planUsage: { autoPercentUsed: 10, apiPercentUsed: 90 },
        billingCycleEnd: "1800000000000",
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const usage = await readCursorUsage(
      "fixture-key",
      AbortSignal.timeout(1000),
    );
    expect(usage).toEqual({
      plan: "pro",
      organization: "Example team",
      windows: [
        { id: "cursor", usedPercent: 10, resetsAt: 1_800_000_000_000 },
        { id: "third-party", usedPercent: 90, resetsAt: 1_800_000_000_000 },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("does not substitute a pooled total for unavailable individual pools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("exchange_user_api_key")
          ? Response.json({ accessToken: "fixture-access-token" })
          : url.endsWith("GetCurrentPeriodUsage")
            ? Response.json({ planUsage: { totalSpend: 1000, limit: 2000 } })
            : new Response("Provider detail must not escape", { status: 403 }),
      ),
    );
    expect(
      await readCursorUsage("fixture-key", AbortSignal.timeout(1000)),
    ).toEqual({ windows: [] });
  });
  it("bounds provider responses and never includes error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret fixture-token", { status: 401 })),
    );
    await expect(
      readUsageJson(
        "https://api.anthropic.com/api/oauth/usage",
        {},
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow(/^Usage request failed \(401\)\.$/);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(" ".repeat(256 * 1024 + 1))),
    );
    await expect(
      readUsageJson(
        "https://api.anthropic.com/api/oauth/usage",
        {},
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("too large");
  });
});
