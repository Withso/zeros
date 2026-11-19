import { describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import type { TransportClient } from "../transport/types";
import { DESIGN_CANVAS_ITEMS_CAPABILITY } from "@zeros/protocol/design-canvas-items";
import { DESIGN_CATALOG_READ_CAPABILITY, DESIGN_CATALOG_WIDE_BATCHES_CAPABILITY, DESIGN_COMPONENT_OPTIONS_CAPABILITY, DESIGN_FRAMES_CHANGES_CAPABILITY, DESIGN_FRAMES_LINT_CAPABILITY, DESIGN_FRAMES_PREPARE_LINT_CAPABILITY, DESIGN_LAZY_PREPARATION_CAPABILITY, DESIGN_OPTIONS_SHOW_NOTHING_CAPABILITY, DESIGN_MUTATION_SNAPSHOTS_CAPABILITY, DESIGN_PAGE_SCOPED_MUTATIONS_CAPABILITY } from "@zeros/protocol/design-catalog";
import { DESIGN_PREVIEW_JOBS_CAPABILITY, DESIGN_THUMBNAILS_STORE_CAPABILITY } from "@zeros/protocol/design-capture";
import { DESIGN_SOURCE_SURFACES_CAPABILITY } from "@zeros/protocol/design-surface";
import { DESIGN_COPY_PLACEMENT_CAPABILITY } from "@zeros/protocol/design-relocation";
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
          capabilities: [DESIGN_CATALOG_READ_CAPABILITY, CONVERSATION_REPLAY_CAPABILITY, ...(kind === "local" ? [DESIGN_PREVIEW_JOBS_CAPABILITY, DESIGN_LAZY_PREPARATION_CAPABILITY, DESIGN_SOURCE_SURFACES_CAPABILITY,
            // Component options ride the prepared frame record, which only a Local engine serves.
            DESIGN_COMPONENT_OPTIONS_CAPABILITY,
            // Lint rows ride the same Local preparation reply, or a Local lint read.
            DESIGN_FRAMES_PREPARE_LINT_CAPABILITY, DESIGN_FRAMES_LINT_CAPABILITY, DESIGN_OPTIONS_SHOW_NOTHING_CAPABILITY,
            DESIGN_COPY_PLACEMENT_CAPABILITY, // Stored thumbnails need no capture host; batch rendering does, and none runs here.
            DESIGN_MUTATION_SNAPSHOTS_CAPABILITY, DESIGN_PAGE_SCOPED_MUTATIONS_CAPABILITY, DESIGN_THUMBNAILS_STORE_CAPABILITY, DESIGN_FRAMES_CHANGES_CAPABILITY,
            // Canvas items are written through Local Design routes only.
            DESIGN_CANVAS_ITEMS_CAPABILITY,
            // Wide catalog batches are Local: a remote transport keeps 256 KB replies.
            DESIGN_CATALOG_WIDE_BATCHES_CAPABILITY] : [])],
        }),
      );
      expect(JSON.stringify(vi.mocked(client.send).mock.calls)).not.toContain(
        "largeCatalog",
      );
    },
  );
});
