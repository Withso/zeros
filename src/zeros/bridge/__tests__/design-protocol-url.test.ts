import { describe, expect, it } from "vitest";

import { designProtocolFrameUrl } from "../design-protocol-url";

describe("design protocol frame URLs", () => {
  it("carries the exact workspace capability in the inheritable path", () => {
    const capability = "c".repeat(64);
    expect(
      designProtocolFrameUrl({
        workspaceId: "ws_a",
        capability,
        frame: "landing page.html",
        sourceVersion: "a".repeat(24),
      }),
    ).toBe(
      `zeros-design://workspace/ws_a/${capability}/landing%20page.html?v=${"a".repeat(24)}`,
    );
  });

  it("fails closed when no workspace capability is available", () => {
    expect(
      designProtocolFrameUrl({
        workspaceId: "ws_a",
        capability: null,
        frame: "home.html",
        sourceVersion: "a".repeat(24),
      }),
    ).toBeNull();
  });
});
