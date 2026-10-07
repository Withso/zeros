import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, writeJournal } from "../cloud-workspace-validation/live-update-acceptance/cli.mts";
import type { AlphaLiveUpdateAdapter, Journal } from "../cloud-workspace-validation/live-update-acceptance/contract";

const mocked = vi.hoisted(() => ({ factory: vi.fn(), readCredentials: vi.fn() }));
vi.mock("../cloud-workspace-validation/live-update-acceptance/contract.ts", async original => ({
  ...await original<typeof import("../cloud-workspace-validation/live-update-acceptance/contract")>(),
  createAlphaLiveUpdateAdapter: mocked.factory,
}));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: (...args: Parameters<typeof fs.readFile>) =>
    String(args[0]).endsWith("/.env.agent") ? mocked.readCredentials() : fs.readFile(...args) };
});

function adapterFixture(): AlphaLiveUpdateAdapter {
  const identity = { version: 1 as const, channel: "alpha" as const, staff: true as const, organizationId: randomUUID() };
  return {
    identity: vi.fn(async () => identity),
    preflight: vi.fn(async () => ({ ...identity, sourceRuntimeId: "r1-11111111", targetRuntimeId: "r1-22222222",
      capabilities: { residentHandoff: true, freshProofs: true, rollbackPair: true, heldTurn: true,
        inputAcknowledgements: false, healthFailureInjection: true, idempotentCreateAndCleanup: true } })),
    provision: vi.fn(async () => { throw new Error("Creation must remain blocked"); }),
    connect: vi.fn(async () => { throw new Error("Connection must remain blocked"); }),
    stage: vi.fn(async () => { throw new Error("Staging must remain blocked"); }),
    handoff: vi.fn(async () => { throw new Error("Handoff must remain blocked"); }),
    cleanup: vi.fn(async () => ({ complete: true, remainingResources: 0 })),
  };
}

describe("Alpha live runtime acceptance CLI", () => {
  let directory: string, configPath: string;
  const adapterPath = "scripts/cloud-workspace-validation/live-update-acceptance/contract.ts";
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "zeros-v2-test-lu-cli-"));
    configPath = path.join(directory, "config.json"); await writeFile(configPath, "{}\n");
    mocked.factory.mockReset(); mocked.readCredentials.mockReset();
    mocked.readCredentials.mockResolvedValue([
      "ZEROS_HU_ALPHA_ACCESS_TOKEN=synthetic-access-value",
      "ZEROS_HU_ALPHA_DATABASE_URL=synthetic-database-value",
      "ZEROS_HU_UNREVIEWED_KEY=synthetic-unreviewed-value",
      "ZEROS_PLANETSCALE_ALPHA_DATABASE=synthetic-alpha-selector",
    ].join("\n"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true });
  });
  it("passes the real explicit config and only reviewed file credentials without an environment fallback", async () => {
    const adapter = adapterFixture(); mocked.factory.mockResolvedValue(adapter);
    vi.stubEnv("BOAT_API_KEY", "synthetic-environment-value");
    expect(await main(["--adapter", adapterPath, "--config", configPath, "--name-prefix", "zeros-v2-test-hu"])).toBe(2);
    expect(mocked.factory).toHaveBeenCalledOnce();
    const supplied = mocked.factory.mock.calls[0][0];
    expect(supplied.configPath).toBe(configPath); expect(supplied.signal).toBeInstanceOf(AbortSignal);
    expect([...supplied.credentials.keys()].sort()).toEqual([
      "ZEROS_HU_ALPHA_ACCESS_TOKEN", "ZEROS_HU_ALPHA_DATABASE_URL", "ZEROS_PLANETSCALE_ALPHA_DATABASE",
    ]);
    expect(adapter.preflight).toHaveBeenCalledOnce(); expect(adapter.provision).not.toHaveBeenCalled();
    const output = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(JSON.parse(output)).toMatchObject({ outcome: "blocked", code: "capability_unqualified", cleaned: true });
    expect(output).not.toContain("synthetic-");
  });
  it("resumes an old HU cleanup journal using identity when pair preflight refuses", async () => {
    const adapter = adapterFixture(); mocked.factory.mockResolvedValue(adapter);
    vi.mocked(adapter.preflight).mockRejectedValue(new Error("Qualification revoked"));
    const organizationId = (await adapter.identity(AbortSignal.timeout(1000))).organizationId;
    vi.mocked(adapter.identity).mockClear();
    const operationId = randomUUID(), name = `zeros-v2-test-hu-${operationId}`;
    const record: Journal = { version: 1, operationId, name, phase: "allocated",
      workspace: { organizationId, workspaceId: randomUUID() },
      actions: { input: randomUUID(), prompt: randomUUID(), update: randomUUID(), rollback: randomUUID() } };
    const context = path.resolve(".context"), file = path.join(context, `${name}.json`);
    try {
      await writeJournal(context, record);
      expect(await main(["--adapter", adapterPath, "--config", configPath, "--cleanup", file])).toBe(0);
      expect(adapter.identity).toHaveBeenCalledOnce(); expect(adapter.preflight).not.toHaveBeenCalled();
      expect(adapter.cleanup).toHaveBeenCalledOnce();
      const output = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(JSON.parse(output)).toMatchObject({ outcome: "passed", code: "cleanup_verified", cleaned: true });
    } finally { await rm(file, { force: true }); }
  });
  it("does not accept empty inventory in a different organization after a lost provision reply", async () => {
    const adapter = adapterFixture(); mocked.factory.mockResolvedValue(adapter);
    const operationId = randomUUID(), name = `zeros-v2-test-lu-${operationId}`;
    const record: Journal = { version: 1, operationId, name, organizationId: randomUUID(), phase: "allocated" };
    const context = path.resolve(".context"), file = path.join(context, `${name}.json`);
    try {
      await writeJournal(context, record);
      expect(await main(["--adapter", adapterPath, "--config", configPath, "--cleanup", file])).toBe(1);
      expect(adapter.identity).toHaveBeenCalledOnce(); expect(adapter.preflight).not.toHaveBeenCalled();
      expect(adapter.cleanup).not.toHaveBeenCalled();
      const output = vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(JSON.parse(output)).toMatchObject({ outcome: "cleanup_required", code: "cleanup_unconfirmed", cleaned: false });
    } finally { await rm(file, { force: true }); }
  });
  it.each(["missing config", "unknown prefix"])("refuses %s before credential reads or adapter imports", async kind => {
    const args = kind === "missing config" ? ["--adapter", adapterPath] :
      ["--adapter", adapterPath, "--config", configPath, "--name-prefix", "zeros-v2-test-unreviewed"];
    expect(await main(args)).toBe(2);
    expect(mocked.readCredentials).not.toHaveBeenCalled(); expect(mocked.factory).not.toHaveBeenCalled();
  });
});
