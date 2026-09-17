import { describe, expect, it } from "vitest";
import { mcpServerSchema, sanitizeLayer } from "../../settings/schema";
import {
  dedupeMcpServers,
  mcpServersFromSettings,
  MCP_SECRET_SENTINEL,
} from "../mcp-registry";
import { materializeMcpServerRegistration } from "../mcp-registration";
import type { McpServerRegistration } from "../types";

const server = {
  name: "reports",
  transport: "sse",
  url: "https://reports.example/sse",
} as const;

describe("explicit SSE MCP transport", () => {
  it.each(["user", "managed", "repo-local", "workspace-local"] as const)(
    "survives %s settings validation and registry projection",
    (layer) => {
      expect(mcpServerSchema.safeParse(server).success).toBe(true);
      const { doc } = sanitizeLayer({ mcp: { servers: [server] } }, layer);
      expect(mcpServersFromSettings(doc)).toEqual([server]);
    },
  );

  it("partitions gateway credentials and excludes disabled servers", () => {
    expect(
      mcpServersFromSettings({
        mcp: {
          servers: [
            { ...server, auth: "oauth" },
            { ...server, name: "key", auth: "header" },
            { ...server, name: "off", enabled: false },
            {
              ...server,
              name: "direct",
              headers: { Authorization: MCP_SECRET_SENTINEL, "X-Version": "1" },
            },
          ],
        },
      }),
    ).toEqual([{ ...server, name: "direct", headers: { "X-Version": "1" } }]);
  });

  it("deduplicates by transport and endpoint, retaining name precedence", () => {
    const servers = [
      server,
      { ...server, name: "other", url: "https://other.example/sse" },
      { ...server, name: "duplicate" },
      { ...server, name: "http", transport: "http" },
      { ...server, transport: "http" },
    ] as McpServerRegistration[];
    expect(dedupeMcpServers(servers)).toEqual(
      servers.slice(0, 2).concat(servers[3]!),
    );
  });

  it("materializes SSE credential references without changing transport or the durable registry", () => {
    const registration = {
      ...server,
      headersFromEnv: { Authorization: "MCP_TEST_CREDENTIAL" },
    } as McpServerRegistration;
    expect(
      materializeMcpServerRegistration(registration, {
        MCP_TEST_CREDENTIAL: "test-header",
      }),
    ).toEqual({ ...server, headers: { Authorization: "test-header" } });
    expect(registration).not.toHaveProperty("headers");
    expect(() => materializeMcpServerRegistration(registration, {})).toThrow(
      /missing.*credential/i,
    );
  });
});
