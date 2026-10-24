import { describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { TransportClient } from "../transport/types";
import { DESIGN_CATALOG_READ_CAPABILITY } from "@zeros/protocol/design-catalog";
import { CONVERSATION_REPLAY_CAPABILITY } from "@zeros/protocol/conversation-replay";

const connect = (
  ZerosEngine.prototype as unknown as {
    handleConnect(this: unknown, client: TransportClient): Promise<void>;
  }
).handleConnect;
describe("Design catalog capability advertisement", () => {
  it.each(["local", "cloud"] as const)(
    "advertises Design reads alongside canonical replay for %s connections",
    async (kind) => {
      const client: TransportClient = {
        id: "catalog-client",
        kind,
        send: vi.fn(),
        close: vi.fn(),
      };
      await connect.call(
        {
          cloudWorker: false,
          cloudCommands: null,
          root: "/local",
          framework: "unknown",
          actualPort: 1,
        },
        client,
      );
      expect(client.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "ENGINE_READY",
          capabilities: [DESIGN_CATALOG_READ_CAPABILITY, CONVERSATION_REPLAY_CAPABILITY],
        }),
      );
      expect(JSON.stringify(vi.mocked(client.send).mock.calls)).not.toContain(
        "largeCatalog",
      );
    },
  );
});
