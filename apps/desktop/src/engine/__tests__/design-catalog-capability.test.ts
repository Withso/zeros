import { describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { TransportClient } from "../transport/types";
import { DESIGN_CATALOG_READ_CAPABILITY } from "@zeros/protocol/design-catalog";

const connect = (
  ZerosEngine.prototype as unknown as {
    handleConnect(this: unknown, client: TransportClient): Promise<void>;
  }
).handleConnect;
describe("Design catalog capability advertisement", () => {
  it.each(["local", "cloud"] as const)(
    "advertises only the read contract for %s connections",
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
          capabilities: [DESIGN_CATALOG_READ_CAPABILITY],
        }),
      );
      expect(JSON.stringify(vi.mocked(client.send).mock.calls)).not.toContain(
        "largeCatalog",
      );
    },
  );
});
