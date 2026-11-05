import { describe, expect, it } from "vitest";

import { extensionEntryView } from "../extension-entry-view";

const entry = {
  description: "Search issues and pull requests",
  statusDetail: undefined as string | undefined,
};

describe("extensionEntryView", () => {
  it("shows an available entry's description and no badge", () => {
    expect(extensionEntryView({ ...entry, status: "available" })).toEqual({
      badge: null,
      hint: "Search issues and pull requests",
      detail: undefined,
    });
  });

  it("puts the remedy in the line when the status needs the person", () => {
    const detail = "Reconnect this account connector in Claude.";
    expect(extensionEntryView({ ...entry, status: "needs-auth", statusDetail: detail })).toEqual({
      badge: { label: "Sign-in required", tone: "warning" },
      hint: detail,
      detail: undefined,
    });
    expect(
      extensionEntryView({ ...entry, status: "disabled", statusDetail: "Disabled by your Codex organization." })
        .hint,
    ).toBe("Disabled by your Codex organization.");
    expect(extensionEntryView({ ...entry, status: "unavailable" }).hint).toBe(
      "Search issues and pull requests",
    );
  });

  it("keeps the description for an informational status and offers its detail on the badge", () => {
    const detail = "Reported by Codex. Native plugin MCP tools remain subject to the session's tool permissions.";
    expect(extensionEntryView({ ...entry, status: "configured", statusDetail: detail })).toEqual({
      badge: { label: "Configured", tone: "neutral" },
      hint: "Search issues and pull requests",
      detail,
    });
  });
});
