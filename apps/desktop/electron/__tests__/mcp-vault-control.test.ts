import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/unused-mcp-vault" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ""),
  },
}));

import { persistMcpVaultControl } from "../mcp-control-client";
import { getSecret, setSecret } from "../secret-store";
import { MCP_VAULT_ACCOUNT, vaultControlLine } from "../../src/engine/agents/gateway/vault-persist";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "zeros-mcp-vault-"));
  directories.push(directory);
  vi.stubEnv("ZEROS_SHARED_SECRETS_DIR", directory);
  let current = true;
  const output: unknown[] = [];
  const persist = vi.fn((snapshot: object) => setSecret(MCP_VAULT_ACCOUNT, JSON.stringify(snapshot)));
  const deps = { current: () => current, persist, write: (line: string) => { output.push(JSON.parse(line)); return true; } };
  return { directory, output, persist, deps, retire: () => { current = false; } };
}

describe("private MCP vault persistence acknowledgement", () => {
  it("acknowledges durable writes and preserves legacy messages without a request ID", () => {
    const f = fixture(), requestId = randomUUID();
    const snapshot = { fixture: { env: { KEY: "fixture-only-vault-value" } } };
    expect(persistMcpVaultControl(JSON.parse(vaultControlLine(snapshot, requestId)), f.deps)).toBe(true);
    expect(JSON.parse(getSecret(MCP_VAULT_ACCOUNT)!)).toEqual(snapshot);
    expect(f.output).toEqual([{ type: "host.mcpVaultPersisted", requestId, ok: true }]);
    persistMcpVaultControl(JSON.parse(vaultControlLine({})), f.deps);
    expect(getSecret(MCP_VAULT_ACCOUNT)).toBe("{}");
    expect(f.output).toHaveLength(1);
  });

  it("reports a real file write failure without losing the prior vault or exposing its error", () => {
    const f = fixture(), requestId = randomUUID();
    setSecret(MCP_VAULT_ACCOUNT, JSON.stringify({ prior: {} }));
    const filename = path.join(f.directory, "secrets.json");
    const before = readFileSync(filename, "utf8");
    mkdirSync(`${filename}.tmp-${process.pid}`);
    persistMcpVaultControl({ type: "mcp.vault", requestId, data: { next: { token: "fixture-secret" } } }, f.deps);
    expect(f.output).toEqual([{ type: "host.mcpVaultPersisted", requestId, ok: false }]);
    expect(readFileSync(filename, "utf8")).toBe(before);
  });

  it("rejects stale-child writes and fences acknowledgements when the child retires during persistence", () => {
    const stale = fixture(); stale.retire();
    persistMcpVaultControl({ type: "mcp.vault", requestId: randomUUID(), data: {} }, stale.deps);
    expect(stale.persist).not.toHaveBeenCalled(); expect(stale.output).toEqual([]);
    const f = fixture();
    f.persist.mockImplementation(snapshot => { setSecret(MCP_VAULT_ACCOUNT, JSON.stringify(snapshot)); f.retire(); });
    persistMcpVaultControl({ type: "mcp.vault", requestId: randomUUID(), data: {} }, f.deps);
    expect(f.persist).toHaveBeenCalledOnce(); expect(f.output).toEqual([]);
  });

  it("does not persist malformed acknowledged snapshots or echo invalid request IDs", () => {
    const f = fixture(), requestId = randomUUID();
    persistMcpVaultControl({ type: "mcp.vault", requestId, data: [] }, f.deps);
    expect(f.output).toEqual([{ type: "host.mcpVaultPersisted", requestId, ok: false }]);
    persistMcpVaultControl({ type: "mcp.vault", requestId: "invalid", data: {} }, f.deps);
    expect(f.output).toHaveLength(1); expect(f.persist).not.toHaveBeenCalled();
    expect(persistMcpVaultControl({ type: "unrelated" }, f.deps)).toBe(false);
  });
});
