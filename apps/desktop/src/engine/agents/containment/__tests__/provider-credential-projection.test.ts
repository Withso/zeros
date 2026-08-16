import { describe, expect, it } from "vitest";

import { deriveProviderCredentialProjection } from "../provider-credential-projection";

describe("provider credential projection", () => {
  it("scopes Claude credentials to the exact default HTTPS authority", () => {
    expect(
      deriveProviderCredentialProjection("claude", {
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
      }),
    ).toEqual([
      {
        name: "ANTHROPIC_API_KEY",
        injectAuthorities: ["api.anthropic.com:443"],
        allowPlaintext: false,
      },
      {
        name: "ANTHROPIC_AUTH_TOKEN",
        injectAuthorities: ["api.anthropic.com:443"],
        allowPlaintext: false,
      },
    ]);
  });

  it("preserves an explicitly configured loopback gateway without broadening its port", () => {
    expect(
      deriveProviderCredentialProjection("claude", {
        ANTHROPIC_AUTH_TOKEN: "gateway-token",
        ANTHROPIC_BASE_URL: "http://[::1]:43123/anthropic/v1",
      }),
    ).toEqual([
      {
        name: "ANTHROPIC_AUTH_TOKEN",
        injectAuthorities: ["[::1]:43123"],
        allowPlaintext: true,
      },
    ]);
  });

  it("rejects a malformed or non-HTTP provider endpoint before exposing a key", () => {
    expect(() =>
      deriveProviderCredentialProjection("claude", {
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_BASE_URL: "file:///tmp/collector",
      }),
    ).toThrow(/HTTP\(S\)/);
    expect(() =>
      deriveProviderCredentialProjection("codex", {
        OPENAI_API_KEY: "sk-test",
        OPENAI_BASE_URL: "not a URL",
      }),
    ).toThrow(/valid absolute URL/);
  });

  it("covers both Cursor control and inference authorities", () => {
    expect(
      deriveProviderCredentialProjection("cursor", {
        CURSOR_API_KEY: "cursor-test",
      }),
    ).toEqual([
      {
        name: "CURSOR_API_KEY",
        injectAuthorities: ["api.cursor.com:443", "api2.cursor.sh:443"],
        allowPlaintext: false,
      },
    ]);
  });

  it("does not guess credential semantics for generic or future providers", () => {
    expect(
      deriveProviderCredentialProjection("future-agent", {
        API_KEY: "application-owned",
        OPENAI_API_KEY: "not-this-provider",
      }),
    ).toEqual([]);
  });
});
