import { describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { TransportClient } from "../transport/types";
import { DESIGN_CATALOG_READ_CAPABILITY, DESIGN_LAZY_PREPARATION_CAPABILITY } from "@zeros/protocol/design-catalog";
import { DESIGN_PREVIEW_JOBS_CAPABILITY } from "@zeros/protocol/design-capture";
import { DESIGN_SOURCE_SURFACES_CAPABILITY } from "@zeros/protocol/design-surface";
import { CONVERSATION_REPLAY_CAPABILITY } from "@zeros/protocol/conversation-replay";

const connect = (
  ZerosEngine.prototype as unknown as {
    handleConnect(this: unknown, client: TransportClient): Promise<void>;
  }
).handleConnect;
describe("Design catalog capability advertisement", () => {
  it.each(["local", "cloud"] as const)(
    "advertises canonical replay and keeps preview preparation Local for %s connections",
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
          capabilities: [DESIGN_CATALOG_READ_CAPABILITY, CONVERSATION_REPLAY_CAPABILITY, ...(kind === "local" ? [DESIGN_PREVIEW_JOBS_CAPABILITY, DESIGN_LAZY_PREPARATION_CAPABILITY, DESIGN_SOURCE_SURFACES_CAPABILITY] : [])],
        }),
      );
      expect(JSON.stringify(vi.mocked(client.send).mock.calls)).not.toContain(
        "largeCatalog",
      );
    },
  );
});
