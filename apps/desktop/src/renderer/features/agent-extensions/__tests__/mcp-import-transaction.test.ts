import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpSecretEnvAlias } from "@zeros/protocol/mcp-secrets";
import { mcpCredentialKey } from "../../../../engine/agents/gateway/credential-key";
import { OAuthVault, type BackendCredentials } from "../../../../engine/agents/gateway/oauth-provider";
import { mcpServersFromSettings } from "../../../../engine/agents/mcp-registry";
import { commitMcpCredentials, mcpSaveInputSchema, opMcpSaveServer } from "../../../../engine/settings/mcp-configuration";
import { opSettingsRead, opSettingsWrite } from "../../../../engine/settings/ops";
import type { DiscoveredMcpServerWire, DiscoveredMcpSourceWire } from "../../../platform/bridge/workspace-bridge";
import { looksSecretEnvName, setMcpSecret } from "../../agent/mcp-secrets";
import { mcpDraftError, secretChangesFromDraft, type McpSecretChanges } from "../mcp-form-save";
import { MCP_SECRET_SENTINEL, readRawServers, secureDraftFromServer, serverFromDraft, type RawServer } from "../mcp-server-model";

const storage = vi.hoisted(() => ({ legacy: new Map<string, string>(), directory: "" }));
vi.mock("../../../platform/secrets", () => ({
  setSecret: async (name: string, value: string) => { storage.legacy.set(name, value); },
  getSecret: async (name: string) => storage.legacy.get(name) ?? null,
  deleteSecret: async (name: string) => { storage.legacy.delete(name); },
}));
vi.mock("../../../../engine/settings/files", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../engine/settings/files")>(),
  userSettingsPath: () => path.join(storage.directory, "settings.toml"),
}));

const source = readFileSync(new URL("../mcp-import-dialog.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("mcp-import-dialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ["looksSecretHeaderValue", "isSecretHeader", "importToSettings", "importNameErrors", "selectedImports", "sameImportEntry"].includes(node.name?.text ?? ""))
  .map(node => node.getText(ast).replace(/^export /, "")).join("\n");
let handler = "";
(function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleImport") handler = node.initializer!.getText(ast);
  ts.forEachChild(node, visit);
})(ast);
const dependencies = { looksSecretEnvName, setMcpSecret, MCP_SECRET_SENTINEL, secureDraftFromServer, serverFromDraft, secretChangesFromDraft, mcpDraftError, crypto: { randomUUID } };
type ImportResult = { entry: RawServer; secrets?: McpSecretChanges; headerSecret?: { url: string; headerName: string; value: string } };
const importer = vm.runInNewContext(ts.transpileModule(`${declarations}\nimportToSettings;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, dependencies) as (server: DiscoveredMcpServerWire, id?: string) => ImportResult | Promise<ImportResult>;

beforeEach(() => { storage.directory = mkdtempSync(path.join(tmpdir(), "zeros-mcp-import-")); });
afterEach(() => { rmSync(storage.directory, { recursive: true, force: true }); storage.legacy.clear(); });

function persistence() {
  const vault = new OAuthVault();
  let durable: Record<string, BackendCredentials> = {};
  const persist = vi.fn(async (snapshot: Record<string, BackendCredentials>) => { durable = structuredClone(snapshot); });
  const save = async (entry: RawServer, secrets?: McpSecretChanges, previous: RawServer | null = null) =>
    opMcpSaveServer(mcpSaveInputSchema.parse({ layer: "user", previous, server: entry, secrets }),
      (server, changes, root, write, prior) => commitMcpCredentials(vault, server, changes, root, write, prior, persist));
  return { vault, persist, save, durable: () => durable };
}

describe("native MCP import credentials", () => {
  it("keeps same-named STDIO variables isolated through settings, vault, and provider aliases", async () => {
    const f = persistence();
    const first = await importer({ name: "one", transport: "stdio", command: "one", env: { API_KEY: "fixture-one" } });
    const second = await importer({ name: "two", transport: "stdio", command: "two", env: { API_KEY: "fixture-two" } });
    expect(first.entry.credential_id).toEqual(expect.any(String));
    expect(second.entry.credential_id).not.toBe(first.entry.credential_id);
    for (const result of [first, second]) await f.save(result.entry, result.secrets);
    const doc = opSettingsRead("user").doc;
    const servers = mcpServersFromSettings(doc);
    expect(servers).toHaveLength(2);
    for (const [offset, result] of [first, second].entries()) {
      const id = String(result.entry.credential_id);
      const server = servers[offset];
      expect(server.transport).toBe("stdio");
      if (server.transport !== "stdio") throw new Error("Expected STDIO");
      expect(server.envFromEnv?.API_KEY).toBe(mcpSecretEnvAlias(id, "API_KEY"));
      expect(f.vault.readEntry(server.credentialKey!)?.env?.API_KEY).toBe(offset ? "fixture-two" : "fixture-one");
    }
    expect(storage.legacy.size).toBe(0);
    expect(JSON.stringify(doc)).not.toMatch(/fixture-one|fixture-two/);
    expect(f.durable()).toEqual(f.vault.snapshot());
  });

  it.each(["http", "sse"] as const)("preserves OAuth resource headers through the canonical %s configuration save", async transport => {
    const f = persistence();
    const headers = { "X-Tenant": "acme", "X-Version": "1", "X-Api-Key": "fixture-resource" };
    const result = await importer({ name: "tenant", transport, url: "https://fixture.invalid/mcp", headers,
      oauth: { clientId: "public-fixture", scopes: ["read"] } });
    expect(Object.keys(result.entry.headers ?? {})).toEqual(Object.keys(headers));
    await f.save(result.entry, result.secrets);
    const [saved] = readRawServers(opSettingsRead("user").doc);
    expect(saved).toMatchObject({ transport, auth: "oauth", oauth_client_id: "public-fixture", oauth_scopes: ["read"] });
    expect(f.vault.getHeaders(mcpCredentialKey(String(saved.credential_id), String(saved.url)))).toEqual(headers);
    expect(JSON.stringify(saved)).not.toContain("fixture-resource");
  });
});

function harness(servers: DiscoveredMcpServerWire[], extraSources: DiscoveredMcpSourceWire[] = []) {
  const f = persistence();
  const sources = [{ source: "fixture", label: "Fixture", path: "/fixture", exists: true, servers }, ...extraSources];
  const context = {
    ...dependencies, sources, connected: true, scanError: null, loading: false, busy: false,
    layer: { doc: {} }, settingsLoading: false, settingsReadError: null,
    setBusy: vi.fn(), existingNames: new Set<string>(), composedNames: new Set<string>(), existing: [] as RawServer[],
    selected: new Set(sources.flatMap(src => src.servers.map(srv => `${src.source}::${srv.name}`))),
    names: {} as Record<string, string>, imported: new Set<string>(), credentialIds: { current: new Map<string, string>() },
    importGeneration: { current: 0 }, importPending: { current: false },
    keyOf: (a: string, b: string) => `${a}::${b}`, importToSettings: importer,
    runtimeExecutionKey: () => "local-generation", bridge: { executionIdentity: {}, status: "connected" },
    write: vi.fn(async (patch: Record<string, unknown>) => { opSettingsWrite("user", patch); }),
    bridgeSettingsRead: vi.fn(async () => opSettingsRead("user")),
    workspaceOp: vi.fn(async (_bridge: unknown, op: string, params: Record<string, unknown>) => {
      expect(op).toBe("mcp.saveServer");
      return f.save(params.server as RawServer, params.secrets as McpSecretChanges, params.previous as RawServer | null);
    }),
    primeSettingsLayer: vi.fn(), refreshSettings: vi.fn(),
    bridgeMcpGatewaySetHeaderSecret: vi.fn(async (_bridge: unknown, url: string, name: string, value: string) => {
      const key = mcpCredentialKey(undefined, url);
      await f.persist({ ...f.vault.snapshot(), [key]: { header: { name, value } } });
      f.vault.setHeader(key, { name, value });
    }),
    toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() }, onClose: vi.fn(), readRawServers,
    setSelected: (update: (prior: Set<string>) => Set<string>) => { context.selected = update(context.selected); },
    setImported: (update: (prior: Set<string>) => Set<string>) => { context.imported = update(context.imported); },
  };
  const run = vm.runInNewContext(ts.transpileModule(`${declarations}\n(${handler})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context) as () => Promise<void>;
  return { ...f, context, run };
}

describe("native MCP import completion", () => {
  it("keeps a failed header-secret import open and retryable without publishing configuration", async () => {
    const f = harness([{ name: "remote", transport: "http", url: "https://fixture.invalid/mcp", headers: { Authorization: "fixture-auth" } }]);
    f.persist.mockRejectedValueOnce(new Error("Vault unavailable"));
    await f.run();
    expect(f.context.toast.success).not.toHaveBeenCalled();
    expect(f.context.onClose).not.toHaveBeenCalled();
    expect(readRawServers(opSettingsRead("user").doc)).toEqual([]);
    expect(f.context.selected.size).toBe(1);
    expect(f.context.toast.error).toHaveBeenCalledOnce();
    const attemptedId = (f.context.workspaceOp.mock.calls[0][2].server as RawServer).credential_id;
    await f.run();
    expect(readRawServers(opSettingsRead("user").doc)).toHaveLength(1);
    expect((f.context.workspaceOp.mock.calls[1][2].server as RawServer).credential_id).toBe(attemptedId);
    expect(f.context.toast.success).toHaveBeenCalledWith("Imported 1 MCP server");
    expect(f.context.onClose).toHaveBeenCalledOnce();
  });

  it("retains only incomplete selections after a partially completed batch", async () => {
    const f = harness([
      { name: "one", transport: "http", url: "https://one.invalid/mcp", headers: { Authorization: "fixture-one" } },
      { name: "two", transport: "http", url: "https://two.invalid/mcp", headers: { Authorization: "fixture-two" } },
    ]);
    f.persist.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("Vault unavailable"));
    await f.run();
    expect(readRawServers(opSettingsRead("user").doc).map(row => row.name)).toEqual(["one"]);
    expect([...f.context.selected]).toEqual(["fixture::two"]);
    expect(f.context.onClose).not.toHaveBeenCalled();
    expect(f.context.toast.success).not.toHaveBeenCalled();
    await f.run();
    expect(readRawServers(opSettingsRead("user").doc).map(row => row.name)).toEqual(["one", "two"]);
    expect(f.context.workspaceOp).toHaveBeenCalledTimes(3);
    expect(f.context.onClose).toHaveBeenCalledOnce();
  });

  it("reconciles a lost save acknowledgement by credential identity before retrying", async () => {
    const f = harness([{ name: "remote", transport: "http", url: "https://fixture.invalid/mcp", headers: { Authorization: "fixture-auth" } }]);
    f.context.workspaceOp.mockImplementationOnce(async (_bridge, _op, params) => {
      await f.save(params.server as RawServer, params.secrets as McpSecretChanges);
      throw new Error("Save reply lost");
    });
    await f.run();
    const [saved] = readRawServers(opSettingsRead("user").doc);
    expect(saved).toBeDefined();
    expect(f.context.onClose).not.toHaveBeenCalled();
    expect(f.context.toast.success).not.toHaveBeenCalled();
    f.context.existingNames.add(String(saved.name));
    await f.run();
    expect(readRawServers(opSettingsRead("user").doc)).toEqual([saved]);
    expect(f.context.workspaceOp).toHaveBeenCalledOnce();
    expect(Object.keys(f.vault.snapshot())).toHaveLength(1);
    expect(f.context.onClose).toHaveBeenCalledOnce();
  });

  it("preserves unrelated configuration written while the vault acknowledgement is pending", async () => {
    const f = harness([{ name: "imported", transport: "stdio", command: "imported", env: { API_KEY: "fixture-auth" } }]);
    const concurrent = { name: "concurrent", transport: "stdio", command: "other" };
    f.persist.mockImplementationOnce(async () => { opSettingsWrite("user", { mcp: { servers: [concurrent] } }); });
    await f.run();
    expect(readRawServers(opSettingsRead("user").doc).map(row => row.name)).toEqual(["concurrent", "imported"]);
    expect(f.context.onClose).toHaveBeenCalledOnce();
    expect(f.context.write).not.toHaveBeenCalled();
  });

  it("asks for distinct names instead of silently skipping a selected project server", async () => {
    const f = harness([{ name: "database", transport: "stdio", command: "first" }], [
      { source: "other-project", label: "Other project", exists: true, path: "/other", servers: [{ name: "database", transport: "stdio", command: "second" }] },
    ]);
    await f.run();
    expect(f.context.toast.success).not.toHaveBeenCalled();
    expect(f.context.onClose).not.toHaveBeenCalled();
    expect(readRawServers(opSettingsRead("user").doc)).toEqual([]);
    f.context.names["other-project::database"] = "other-database";
    await f.run();
    expect(readRawServers(opSettingsRead("user").doc).map(row => row.name)).toEqual(["database", "other-database"]);
    expect(f.context.toast.success).toHaveBeenCalledWith("Imported 2 MCP servers");
  });
});
