import { describe, expect, it, vi } from "vitest";
import { executionMcpServers, type CloudProviderExecution } from "../cloud-provider-execution";
import { cloudClaudeTools } from "../adapters/claude-sdk/cloud-tools";
import { cloudCodexRequest } from "../adapters/codex/cloud-policy";
import { cloudCursorRequest } from "../adapters/cursor-sdk/host/cloud-policy";
import type { McpServerRegistration } from "../types";
import { testCloudRuntime } from "./helpers/test-cloud-runtime";

vi.mock("../containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: () => testCloudRuntime(),
}));

const selectors = {
  GIT_CONFIG_SYSTEM: `${testCloudRuntime().workerRoot}/gitconfig`,
  GIT_EXEC_PATH: `/opt/zeros-infra/.git-exec/${testCloudRuntime().runtimeId}`,
  FONTCONFIG_FILE: `${testCloudRuntime().workerRoot}/design-fonts/fonts.conf`,
  FONTCONFIG_PATH: `${testCloudRuntime().workerRoot}/design-fonts`,
};
const servers: McpServerRegistration[] = [{ name: "fixture", transport: "stdio", command: "node", env: {
  FIXTURE_VALUE: "synthetic-tool-value", GIT_CONFIG_SYSTEM: "/user/gitconfig-trap", GIT_EXEC_PATH: "/user/git-exec-trap",
  FONTCONFIG_FILE: "/user/fontconfig-trap", FONTCONFIG_PATH: "/user/fonts-trap",
} }];

describe("cloud stdio MCP runtime assets", () => {
  it("leaves Local Personal and organization-local registrations unchanged", () => {
    expect(executionMcpServers(null, servers)).toEqual(servers);
    expect(executionMcpServers(null, undefined)).toBeUndefined();
  });
  it.each(["claude", "codex", "cursor"])("passes exact runtime selectors through %s's final MCP configuration", provider => {
    const lifetime = { assertLive: vi.fn() };
    const execution = { mode: "boot-owner-v1", provider, cwd: "/srv/zeros/workspace", model: "fixture-model",
      lifetime, auth: { codexAuth: () => null }, environment: null, nativeCapabilities: null,
      coordinator: { nativeHome: { paths: { codexHome: "/fixture/codex-home" } },
        environment: () => ({ CURSOR_API_KEY: "synthetic-provider-value", OPENAI_API_KEY: "synthetic-provider-value" }) },
      productServers: [], userServers: structuredClone(servers),
    } as unknown as CloudProviderExecution;
    const before = structuredClone(execution.userServers);
    const expected = { FIXTURE_VALUE: "synthetic-tool-value", ...selectors };
    expect(executionMcpServers(execution, [])).toMatchObject([{ env: expected }]);
    if (provider === "claude") expect(cloudClaudeTools(execution).mcpServers).toMatchObject({ fixture: { env: expected } });
    if (provider === "codex") expect(cloudCodexRequest(execution, "fixture", "thread/start", {}))
      .toMatchObject({ config: { mcp_servers: { fixture: { env: expected } } } });
    if (provider === "cursor") expect(cloudCursorRequest(execution, "agent.create", {}))
      .toMatchObject({ mcpServers: { fixture: { env: expected } } });
    expect(execution.userServers).toEqual(before);
    expect(executionMcpServers(null, servers)).toEqual(servers);
  });
});
