import { describe, expect, it } from "vitest";

import {
  createDesignProtocolCapability,
  parseDesignProtocolResourcePath,
  validateDesignProtocolCapability,
} from "../protocol-capability";

describe("design protocol workspace capabilities", () => {
  it("binds an unguessable capability to one workspace and engine launch", () => {
    const secret = "launch-secret-a";
    const workspaceA = createDesignProtocolCapability(secret, "ws_a");
    const workspaceB = createDesignProtocolCapability(secret, "ws_b");

    expect(workspaceA).toMatch(/^[a-f0-9]{64}$/);
    expect(workspaceB).not.toBe(workspaceA);
    expect(validateDesignProtocolCapability(secret, "ws_a", workspaceA)).toBe(
      true,
    );
    expect(validateDesignProtocolCapability(secret, "ws_b", workspaceA)).toBe(
      false,
    );
    expect(
      validateDesignProtocolCapability("launch-secret-b", "ws_a", workspaceA),
    ).toBe(false);
  });

  it("rejects a workspace A capability on a workspace B resource route", () => {
    const secret = "launch-secret";
    const capability = createDesignProtocolCapability(secret, "ws_a");
    expect(
      parseDesignProtocolResourcePath(
        `/design/ws_a/${capability}/assets/logo.png`,
        secret,
      ),
    ).toEqual({ workspaceId: "ws_a", resourcePath: "assets/logo.png" });
    expect(
      parseDesignProtocolResourcePath(
        `/design/ws_b/${capability}/assets/logo.png`,
        secret,
      ),
    ).toBeNull();
  });
});
