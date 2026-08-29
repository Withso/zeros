import { describe, expect, it } from "vitest";

import { bridgeDesignStage } from "../design-bridge";
import type { RuntimeClient } from "../ws-client";

describe("bridgeDesignStage", () => {
  it("sends the dedicated local Design staging operation", async () => {
    const seen: { op?: string; params?: Record<string, unknown> } = {};
    const bridge = {
      request: async (message: {
        op?: string;
        params?: Record<string, unknown>;
      }) => {
        seen.op = message.op;
        seen.params = message.params;
        return {
          type: "WORKSPACE_RESPONSE",
          op: "design.stage",
          result: { ok: true },
        };
      },
    } as unknown as RuntimeClient;

    await expect(bridgeDesignStage(bridge, "workspace-a")).resolves.toEqual({
      ok: true,
    });
    expect(seen).toEqual({
      op: "design.stage",
      params: { workspaceId: "workspace-a" },
    });
  });
});
