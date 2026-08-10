import { describe, expect, it, vi } from "vitest";

import {
  applyBrowserProviderSettings,
  browserProviderForSelection,
  browserProviderWithEndpoint,
  parseBrowserProviderSettings,
  parseBrowserApprovalPolicy,
} from "../../browser/browser-provider-settings";

describe("browser provider settings", () => {
  it("fails browser approval policy persistence closed", () => {
    expect(parseBrowserApprovalPolicy("auto-approve")).toBe("auto-approve");
    expect(parseBrowserApprovalPolicy("ask")).toBe("ask");
    expect(parseBrowserApprovalPolicy("anything-else")).toBe("ask");
  });

  it("normalizes persisted and selected provider shapes", () => {
    expect(parseBrowserProviderSettings('{"provider":"isolated"}')).toEqual({ provider: "isolated" });
    expect(parseBrowserProviderSettings('{"provider":"shared-chrome","endpoint":"http://127.0.0.1:9222"}')).toEqual({
      provider: "shared-chrome",
      endpoint: "http://127.0.0.1:9222",
    });
    expect(parseBrowserProviderSettings("not json")).toEqual({ provider: "isolated" });
    expect(browserProviderForSelection("managed-cloud")).toEqual({
      provider: "managed-cloud",
      endpoint: "https://browser.example.com/cdp",
    });
    expect(browserProviderForSelection("unknown")).toEqual({ provider: "isolated" });
  });

  it("keeps endpoint drafts separate from the last accepted provider", () => {
    expect(browserProviderWithEndpoint(
      { provider: "shared-chrome", endpoint: "http://127.0.0.1:9222" },
      "  http://127.0.0.1:9333  ",
    )).toEqual({ provider: "shared-chrome", endpoint: "http://127.0.0.1:9333" });
    expect(() => browserProviderWithEndpoint({ provider: "isolated" }, "http://localhost:9222"))
      .toThrow(/does not accept an endpoint/i);
  });

  it("persists a provider only after the native host accepts it", async () => {
    const apply = vi.fn(async () => undefined);
    const persist = vi.fn();
    const next = { provider: "shared-chrome", endpoint: "http://127.0.0.1:9222" } as const;
    await expect(applyBrowserProviderSettings(next, apply, persist)).resolves.toEqual(next);
    expect(persist).toHaveBeenCalledWith(next);

    const rejectedPersist = vi.fn();
    await expect(applyBrowserProviderSettings(
      next,
      async () => { throw new Error("endpoint rejected"); },
      rejectedPersist,
    )).rejects.toThrow("endpoint rejected");
    expect(rejectedPersist).not.toHaveBeenCalled();
  });
});
