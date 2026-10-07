import { describe, expect, it, vi } from "vitest";

import {
  loadGenerationCloudProviderConnection,
} from "./provider-connections.js";

describe("generation provider connection lookup", () => {
  it("loads the immutable generation version instead of the rotated current version", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          org_id: "22222222-2222-4222-8222-222222222222",
          provider: "boat",
          credential_source: "hosted",
          endpoint: "hosted://boat-v1",
          region: null,
          current_version: 1,
        },
      ],
    }));

    await expect(
      loadGenerationCloudProviderConnection({ query } as never, {
        workspaceId: "33333333-3333-4333-8333-333333333333",
        organizationId: "22222222-2222-4222-8222-222222222222",
        generation: 1,
      }),
    ).resolves.toMatchObject({
      credentialVersion: 1,
      endpoint: "hosted://boat-v1",
    });
    expect(query.mock.calls[0]?.[0]).toContain(
      "version.version = generation.provider_connection_version",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "version.version AS current_version",
    );
  });
});
