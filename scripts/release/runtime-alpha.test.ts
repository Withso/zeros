import { describe, expect, it, vi } from "vitest";
import { requireCurrentAlphaRuntime } from "./runtime-alpha";

const digest = "a".repeat(64);
const identity = { version: 1, channel: "alpha", ready: true, worker: { sha256: digest } };

describe("public current Alpha runtime admission", () => {
  it("reads only the public current identity without fixture, store or signing credentials", async () => {
    const request = vi.fn(async () => Response.json(identity));
    await requireCurrentAlphaRuntime(digest, request);
    expect(request).toHaveBeenCalledExactlyOnceWith("https://api-alpha.zeros.build/v1/release-identity", {
      redirect: "error", cache: "no-store", signal: expect.any(AbortSignal),
    });
  });
  it("allows an original publication's digest restored by an Alpha rollback", async () => {
    await expect(requireCurrentAlphaRuntime(digest, async () => Response.json({ ...identity,
      worker: { ...identity.worker, qualification: { runId: "999", runAttempt: 2 } } }))).resolves.toBeUndefined();
  });
  it.each([{ ready: false }, { channel: "beta" }, { worker: null }, { worker: { sha256: "b".repeat(64) } }, { version: 2 }])(
    "refuses unready, foreign or incomplete Alpha identity (%j)", async patch => {
      await expect(requireCurrentAlphaRuntime(digest, async () => Response.json({ ...identity, ...patch }))).rejects.toThrow(/Alpha's current ready runtime/);
    });
  it.each([401, 404, 429, 500, 503])("refuses HTTP %s without retrying or exposing response text", async status => {
    const request = vi.fn(async () => new Response("synthetic-private-upstream", { status }));
    await expect(requireCurrentAlphaRuntime(digest, request)).rejects.toThrow(/^Promotion requires this digest to be Alpha's current ready runtime\./);
    expect(request).toHaveBeenCalledOnce();
  });
  it.each(["network", "invalid", "oversized"])("fails closed on %s responses", async kind => {
    const request = vi.fn(async () => {
      if (kind === "network") throw new Error("synthetic-private-upstream");
      return new Response(kind === "invalid" ? "invalid JSON" : " ".repeat(33 * 1024));
    });
    await expect(requireCurrentAlphaRuntime(digest, request)).rejects.toThrow(/verify Alpha before retrying/);
    expect(request).toHaveBeenCalledOnce();
  });
});
