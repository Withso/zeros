import { describe, expect, it, vi } from "vitest";
import type { RuntimeMcpServer } from "./contract.js";
import type { CloudV2Workspace } from "./store.js";
import { resolveWorkspaceMcpServers } from "./workspace-repository-mcp.js";

const server = (id: string, name: string): RuntimeMcpServer => ({ id, name, transport: "http", url: `https://mcp.example.test/${id}`, auth: "none" });
const workspace = { id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111", repository: "withso/api",
  projectId: "33333333-3333-4333-8333-333333333333", folder: "zeros-app" } as CloudV2Workspace;
// The later repositories, as otherRepositories reads them.
const tx = { query: vi.fn(async () => ({ rows: [{ repository: "withso/web", repository_id: "43", folder: "web", base_branch: "main" }] })) } as never;

describe("MCP servers of a workspace of several repositories", () => {
  it("delivers every repository's servers once, an organization-wide one once, each resolved with its own repository's identity", async () => {
    const shared = server("org-1", "linear");
    const resolve = vi.fn(async (_org: string, _user: string, repository: string) =>
      repository === "withso/api" ? [shared, server("api-1", "api-db")] : [shared, server("web-1", "web-browser")]);
    const servers = await resolveWorkspaceMcpServers({ resolve }, tx, workspace, "user", { repositoryId: "42" });
    expect(servers.map(entry => entry.id)).toEqual(["org-1", "api-1", "web-1"]);
    expect(resolve.mock.calls.map(call => [call[2], call[3]])).toEqual([["withso/api", { repositoryId: "42" }], ["withso/web", { repositoryId: "43" }]]);
  });

  it("keeps the first repository's server when two repositories configure the same name differently, and says so in the log", async () => {
    const log = vi.fn();
    const resolve = vi.fn(async (_org: string, _user: string, repository: string) =>
      repository === "withso/api" ? [server("api-db", "database")] : [server("web-db", "database")]);
    const servers = await resolveWorkspaceMcpServers({ resolve }, tx, workspace, "user", { repositoryId: "42" }, log);
    expect(servers.map(entry => entry.id)).toEqual(["api-db"]);
    expect(log).toHaveBeenCalledWith('[cloud-v2] mcp server "database" is configured differently for withso/web; withso/api\'s is used');
  });

  it("leaves a workspace of one repository exactly as before", async () => {
    const one = { ...workspace, projectId: undefined, folder: undefined } as CloudV2Workspace;
    const resolve = vi.fn(async () => [server("a", "x"), server("b", "x")]);
    expect((await resolveWorkspaceMcpServers({ resolve }, tx, one, "user", { repositoryId: "42" })).map(entry => entry.id)).toEqual(["a", "b"]);
  });
});
