import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  account: "account-a",
  generation: 1,
  catalog: vi.fn(),
  repositories: vi.fn(),
  cloudConnection: vi.fn(),
  cloudRepositories: vi.fn(),
  request: vi.fn(),
}));
vi.mock("../../team/control-plane", () => ({ CONTROL_PLANE_URL: "https://control.example.test" }));
vi.mock("../../team/team-store", () => ({
  getTeamStoreState: () => ({ me: { user: { id: mocks.account } } }),
  getOrganizationStoreGeneration: () => mocks.generation,
}));
vi.mock("../../../platform/cloud-workspaces", () => ({ cloudAccountRequest: mocks.request }));
vi.mock("../../../platform/cloud-github", () => ({
  readCloudGithubCatalog: mocks.catalog,
  readCloudGithubRepositories: mocks.repositories,
}));
vi.mock("../../../platform/cloud-github-connection", () => ({
  readCloudGithubConnection: mocks.cloudConnection,
  readSelectedCloudRepositories: mocks.cloudRepositories,
}));

import { cloudMcpKey, cloudMcpAuthStatus, probeCloudMcp, readCloudMcpRepositories, startCloudMcpAuth, type CloudMcpExtension } from "../mcp-cloud-api";

const organization = "11111111-1111-4111-8111-111111111111";
const installation = (id: string, connected = true, suspendedAt: string | null = null) => ({ id, connected, suspendedAt });

describe("explicit cloud MCP repository selection", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.account = "account-a"; mocks.generation = 1;
    mocks.cloudConnection.mockResolvedValue({ selectedMethod: "pat", generation: "selected", methods: { pat: { health: "connected" } } });
    mocks.cloudRepositories.mockResolvedValue({ generation: "selected", repositories: [{ owner: "cloud", name: "project" }], nextPage: null, complete: true });
  });
  it("uses the selected cloud method without borrowing the native catalog", async () => {
    await expect(readCloudMcpRepositories(cloudMcpKey(organization, "cloud"))).resolves.toEqual([{ value: "cloud/project", label: "cloud/project" }]);
    expect(mocks.cloudRepositories).toHaveBeenCalledWith("account-a", organization, "selected", 1);
    expect(mocks.catalog).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("does not fall back to Local when cloud sign-in is unavailable", async () => {
    mocks.cloudConnection.mockResolvedValue({ selectedMethod: null });
    await expect(readCloudMcpRepositories(cloudMcpKey(organization, "cloud"))).rejects.toThrow("cloud GitHub");
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it("rejects an owner change during selected-connection enumeration", async () => {
    mocks.cloudRepositories.mockImplementation(async () => { mocks.generation += 2; return { repositories: [], nextPage: null, complete: true }; });
    await expect(readCloudMcpRepositories(cloudMcpKey(organization, "cloud"))).rejects.toThrow("account changed");
  });
});

describe("MCP connection response ownership", () => {
  it.each(["probe", "authorize", "status"])("rejects a late %s reply after account A → B → A", async operation => {
    mocks.account = "account-a"; mocks.generation = 1;
    const key = cloudMcpKey(organization);
    const signal = new AbortController().signal;
    let settle!: (value: unknown) => void;
    mocks.request.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const pending = operation === "probe" ? probeCloudMcp(key, {}, {}, null, signal)
      : operation === "authorize" ? startCloudMcpAuth(key, { config: {}, id: organization, revision: 1 } as CloudMcpExtension, signal)
        : cloudMcpAuthStatus(key, organization, signal);
    mocks.generation += 2;
    settle({ status: "connected", authorizationUrl: "https://identity.example.test/authorize" });
    await expect(pending).rejects.toThrow("account changed");
  });
});

describe("MCP probe inventory compatibility", () => {
  it.each([undefined, [], ["allowed", "disabled"]])("preserves unknown, empty and complete inventories: %j", async tools => {
    const response = { status: "connected", stages: [], toolCount: tools?.length ?? 2, ...(tools === undefined ? {} : { tools }) };
    mocks.request.mockImplementation(async (_path, schema) => schema.parse(response));
    const result = await probeCloudMcp(cloudMcpKey(organization), { name: "tools", transport: "http", url: "https://tools.example.test/mcp" }, {}, null, new AbortController().signal);
    expect(result.tools).toEqual(tools);
    if (tools === undefined) expect(result).not.toHaveProperty("tools");
  });

  it("rejects an oversized inventory at the renderer boundary", async () => {
    mocks.request.mockImplementation(async (_path, schema) => schema.parse({ status: "connected", stages: [], tools: Array.from({ length: 1025 }, (_, index) => `tool_${index}`) }));
    await expect(probeCloudMcp(cloudMcpKey(organization), { name: "tools", transport: "http", url: "https://tools.example.test/mcp" }, {}, null, new AbortController().signal)).rejects.toThrow();
  });
});

describe("MCP organization project admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.account = "account-a";
    mocks.generation = 1;
    mocks.catalog.mockResolvedValue({ complete: true, installations: [installation("connected")] });
    mocks.repositories.mockResolvedValue({ repositories: [], nextPage: null });
    mocks.request.mockResolvedValue({ repositories: [{ repository: "team/project" }] });
  });

  it("refreshes the native human/App repository intersection before reading a cold catalog", async () => {
    const events: string[] = [];
    mocks.catalog.mockImplementation(async () => {
      events.push("catalog");
      return { complete: true, installations: [installation("connected"), installation("disconnected", false), installation("suspended", true, "2026-01-01")] };
    });
    mocks.repositories.mockImplementation(async (_org: string, _id: string, page: number) => {
      events.push(`page:${page}`);
      return { repositories: [], nextPage: page === 1 ? 2 : null };
    });
    mocks.request.mockImplementation(async () => {
      events.push("admitted");
      return { repositories: [{ repository: "team/project" }] };
    });
    await expect(readCloudMcpRepositories(cloudMcpKey(organization))).resolves.toEqual([{ value: "team/project", label: "team/project" }]);
    expect(events).toEqual(["catalog", "page:1", "page:2", "admitted"]);
    expect(mocks.repositories.mock.calls).toEqual([[organization, "connected", 1], [organization, "connected", 2]]);
  });

  it("refreshes expired admission on a later load rather than trusting cached repository names", async () => {
    const key = cloudMcpKey(organization);
    await readCloudMcpRepositories(key);
    await readCloudMcpRepositories(key);
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
    expect(mocks.repositories).toHaveBeenCalledTimes(2);
  });

  it("does not admit stale repositories after an account A → B → A replacement", async () => {
    mocks.repositories.mockImplementation(async () => {
      mocks.generation += 2;
      return { repositories: [], nextPage: 2 };
    });
    await expect(readCloudMcpRepositories(cloudMcpKey(organization))).rejects.toThrow("account changed");
    expect(mocks.repositories).toHaveBeenCalledTimes(1);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("stops before repository enumeration when the catalog belongs to a retired owner", async () => {
    mocks.catalog.mockImplementation(async () => {
      mocks.account = "account-b";
      return { complete: true, installations: [installation("connected")] };
    });
    await expect(readCloudMcpRepositories(cloudMcpKey(organization))).rejects.toThrow("account changed");
    expect(mocks.repositories).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("refuses a repeated pagination cursor without an unbounded request loop", async () => {
    mocks.repositories.mockResolvedValue({ repositories: [], nextPage: 2 });
    await expect(readCloudMcpRepositories(cloudMcpKey(organization))).rejects.toThrow("repository catalog");
    expect(mocks.repositories).toHaveBeenCalledTimes(2);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("does not fall back to stale admission after native GitHub authorization fails", async () => {
    mocks.repositories.mockRejectedValue(new Error("Reconnect GitHub"));
    await expect(readCloudMcpRepositories(cloudMcpKey(organization))).rejects.toThrow("Reconnect GitHub");
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
