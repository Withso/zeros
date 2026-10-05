import { describe, expect, it } from "vitest";

import { designProtocolFrameUrl } from "../design-protocol-url";

describe("design protocol frame URLs", () => {
  it("carries the exact workspace capability in the inheritable path", () => {
    const capability = "c".repeat(64);
    expect(
      designProtocolFrameUrl({
        workspaceId: "ws_a",
        capability,
        frame: "landing.html",
        sourceVersion: "a".repeat(24),
      }),
    ).toBe(
      `zeros-design://workspace/ws_a/${capability}/landing.html?v=${"a".repeat(24)}`,
    );
  });

  it("encodes nested frame routes by segment and rejects aliases", () => {
    const input = { workspaceId: "ws_a", capability: "c".repeat(64), sourceVersion: "a".repeat(24) };
    expect(designProtocolFrameUrl({ ...input, frame: "page-1/home.html" })).toBe(`zeros-design://workspace/ws_a/${input.capability}/page-1/home.html?v=${input.sourceVersion}`);
    for (const frame of ["../home.html", "page-1/sub/home.html", "page-1%2fhome.html", "landing page.html"])
      expect(designProtocolFrameUrl({ ...input, frame })).toBeNull();
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
