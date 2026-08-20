import { describe, expect, it } from "vitest";

import { bridgeDesignSnapshot } from "../design-bridge";
import type { RuntimeClient } from "../ws-client";

describe("Design bridge read budgets", () => {
  it("gives the aggregate cold snapshot enough time to scan a large document", async () => {
    let timeoutMs: number | undefined;
    const bridge = {
      request: async (
        _message: { type: string; op?: string },
        timeout?: number,
      ) => {
        timeoutMs = timeout;
        return {
          type: "WORKSPACE_RESPONSE",
          op: "design.snapshot",
          result: {
            snapshot: {
              protocolCapability: null,
              frames: [],
              tokens: [],
              tokenSourceVersion: "0".repeat(24),
              assets: [],
              lint: {
                workspacePath: "/work/design",
                checkedFiles: [],
                violations: [],
                healedOids: 0,
              },
            },
          },
        };
      },
    } as unknown as RuntimeClient;

    await bridgeDesignSnapshot(bridge, "ws_design");

    expect(timeoutMs).toBe(30_000);
  });
});
