import { describe, expect, it } from "vitest";

import {
  normalizeBrowserProviderConfiguration,
  normalizeManagedCloudEndpoint,
  normalizeSharedChromeEndpoint,
} from "../browser-provider";

describe("browser provider configuration", () => {
  it("accepts isolated mode and local Chrome DevTools endpoints", () => {
    expect(normalizeBrowserProviderConfiguration({ provider: "isolated" })).toEqual({
      provider: "isolated",
    });
    expect(
      normalizeBrowserProviderConfiguration({ provider: "system-computer-use" }),
    ).toEqual({ provider: "system-computer-use" });
    expect(normalizeSharedChromeEndpoint("http://127.0.0.1:9222/")).toBe(
      "http://127.0.0.1:9222",
    );
    expect(normalizeSharedChromeEndpoint("ws://localhost:9222/devtools/browser/id#x")).toBe(
      "ws://localhost:9222/devtools/browser/id",
    );
  });

  it("accepts credential-free managed cloud endpoints and rejects URL secrets", () => {
    expect(normalizeManagedCloudEndpoint("https://browser.example.com/cdp/")).toBe(
      "https://browser.example.com/cdp",
    );
    expect(normalizeManagedCloudEndpoint("wss://browser.example.com/devtools/browser/id")).toBe(
      "wss://browser.example.com/devtools/browser/id",
    );
    expect(() =>
      normalizeManagedCloudEndpoint("wss://browser.example.com/cdp?token=secret"),
    ).toThrow(/encrypted token/i);
    expect(() => normalizeManagedCloudEndpoint("http://browser.example.com")).toThrow(
      /HTTPS or WSS/i,
    );
  });

  it("rejects remote, credential-bearing, and unsupported endpoints", () => {
    expect(() => normalizeSharedChromeEndpoint("https://127.0.0.1:9222")).toThrow(
      /HTTP or WebSocket/i,
    );
    expect(() => normalizeSharedChromeEndpoint("http://example.com:9222")).toThrow(
      /this Mac/i,
    );
    expect(() => normalizeSharedChromeEndpoint("http://user:pass@localhost:9222")).toThrow(
      /credentials/i,
    );
  });
});
