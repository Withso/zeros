import { describe, expect, it, vi } from "vitest";
const settings = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../../platform/settings", () => ({
  getSetting: (key: string, fallback: unknown) => settings.get(key) ?? fallback,
  setSetting: (key: string, value: unknown) => settings.set(key, value),
}));
import {
  connectionLabel,
  connectionMethod,
  rememberConnectionMethod,
} from "../connection-methods";

describe("provider connection choices", () => {
  it("keeps Account/CLI entry choices separate from persisted subscription/API authentication", () => {
    rememberConnectionMethod("claude", "cli");
    expect(connectionMethod("claude", { authMethod: "cli" })).toBe("cli");
    expect(connectionMethod("codex", { authMethod: "cli" })).toBe("account");
    expect(connectionMethod("claude", { authMethod: "apiKey" })).toBe("apiKey");
    rememberConnectionMethod("cursor", "cli");
    expect(connectionMethod("cursor", { authMethod: "cli" })).toBe("account");
  });
  it("labels the effective connection and never calls a disconnected provider connected", () => {
    expect(connectionLabel(false, { authMethod: "cli" }, "Claude")).toBe("Configure Claude");
    expect(connectionLabel(false, { authMethod: "apiKey" }, "Codex")).toBe("Configure Codex");
    expect(connectionLabel(true, { authMethod: "cli" })).toBe(
      "Connected via subscription",
    );
    expect(connectionLabel(true, { authMethod: "apiKey" })).toBe(
      "Connected via API",
    );
    expect(
      connectionLabel(true, {
        authMethod: "apiKey",
        gatewayBaseUrl: "https://ai-gateway.vercel.sh",
      }),
    ).toBe("Connected via Vercel Gateway");
  });
});
