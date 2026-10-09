import { portableCloudWorkloads } from "./helpers/portable-cloud-custody";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentLease } from "../../cloud-agent-lease";
import { CloudExecutionBoundary } from "../cloud-execution-boundary";
import { CloudNativeBoundary } from "../cloud-native-boundary";
import { CloudWorkloadTools } from "../../cloud-workload-tools";
import type { CloudAgentAccessMaterial } from "@zeros/protocol/cloud-agent-execution";
import type { CloudCustomizationSnapshot, CloudSkillSchema } from "@zeros/protocol/cloud-customization";
import type { z } from "zod";

const fixture = vi.hoisted(() => ({ historyRoot: "", configuration: { version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } } }));
vi.mock("../cloud-worker-config", () => ({ loadCloudWorkerConfiguration: () => fixture.configuration,
  isCloudWorkerConfiguration: (value: unknown) => value === fixture.configuration }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime }));
vi.mock("../cloud-native-history", async original => {
  const module = await original<typeof import("../cloud-native-history")>();
  return { ...module, acquireCloudNativeHistory: (input: Parameters<typeof module.acquireCloudNativeHistory>[0]) =>
    module.acquireCloudNativeHistory({ ...input, root: fixture.historyRoot }) };
});
const broker = vi.hoisted(() => vi.fn(async () => ({ env: {}, stopAndProve: async () => {} })));
vi.mock("../../../git/github-native-broker", () => ({ createNativeGithubBroker: broker }));
const roots: string[] = [], leases: CloudAgentLease[] = [];
afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.close();
  vi.unstubAllEnvs(); vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function native(provider: "claude" | "codex" | "cursor", conversationId = randomUUID(), skills?: z.infer<typeof CloudSkillSchema>[]) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zeros-native-cloud-")); roots.push(dataRoot);
  vi.stubEnv("ZEROS_DATA_DIR", dataRoot); fixture.historyRoot = path.join(dataRoot, "history");
  const admission = { executionId: randomUUID(), delegationId: randomUUID(), provider, model: "qualified-model",
    source: { kind: "session" as const, actorSessionId: randomUUID() } };
  const material = { kind: `${provider}-api-key`, apiKey: "synthetic-selected-key" } as CloudAgentAccessMaterial;
  const receipt = { leaseId: randomUUID(), expiresAt: new Date(Date.now() + 45000).toISOString(), credentialVersion: 1 };
  const customization: CloudCustomizationSnapshot | undefined = skills ? { version: 1, digest: "a".repeat(64), repositoryDigest: "b".repeat(64),
    history: { owner: "c".repeat(64), currentKeyVersion: 1, keys: { 1: "a".repeat(43) } },
    servers: [], skills, cursorTeamSettings: "disabled" } : undefined;
  const request = vi.fn(async (input: { kind: string }) => input.kind === "release" ? { released: true } : input.kind === "validate" ? receipt : {
    ...receipt, authorityId: "a".repeat(64),
    credentialKind: material.kind, provider, model: admission.model, material, ...(customization ? { customization } : {}),
    gitAuthor: { name: "Sending member", email: "1234+sender@users.noreply.github.com" } });
  const lease = await CloudAgentLease.admit(admission, request, new AbortController().signal, { onRetirementFailure: vi.fn() }); leases.push(lease);
  const workloads = portableCloudWorkloads(fixture.configuration);
  const boundary = new CloudExecutionBoundary({ configuration: fixture.configuration, workloads });
  const workload = await boundary.prepare({ executionId: admission.executionId, providerId: provider,
    actor: "agent-code", cwd: process.cwd(), workspaceRoot: process.cwd() });
  lease.attach(workload);
  const coordinator = await CloudNativeBoundary.prepare(lease, workload, conversationId);
  return { coordinator, workload, workloads, lease, request, dataRoot, conversationId };
}

describe("native cloud processes share the engine identity", () => {
  it.each(["claude", "codex", "cursor"] as const)("prepares %s organization skills at actual native discovery paths", async provider => {
    const f = await native(provider, randomUUID(), [{ name: "admitted", description: "Approved fixture skill", content: "# Fixture" }]);
    for (const discovery of [".agents", ".claude", ".cursor"]) {
      const skill = path.join(f.coordinator.nativeHome.paths.home, discovery, "skills/admitted/SKILL.md");
      const descriptor = await open(skill, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        expect((await descriptor.stat()).isSymbolicLink()).toBe(false);
        expect(await descriptor.readFile("utf8")).toContain('description: "Approved fixture skill"');
      } finally { await descriptor.close(); }
    }
    // Codex discovers organization skills in .agents; its .codex/skills tree
    // remains native startup state for bundled system skills.
    await expect(lstat(path.join(f.coordinator.nativeHome.paths.codexHome, "skills/admitted"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.lease.close();
  });
  it.each(["claude", "codex", "cursor"] as const)("prepares %s without a sandbox canary and shares physical HOME with tools", async provider => {
    const f = await native(provider);
    expect(f.workloads.snapshot().scopes[0]?.processGroups).toEqual([]);
    expect(f.coordinator.nativeHome.paths.home.startsWith(f.dataRoot + "/native-agent-homes/")).toBe(true);
    expect(f.coordinator.providerHomePath).toBe(f.coordinator.nativeHome.paths.home);
    const key = provider === "claude" ? "ANTHROPIC_API_KEY" : provider === "cursor" ? "CURSOR_API_KEY" : "OPENAI_API_KEY";
    expect(f.coordinator.environment()[key]).toBe("synthetic-selected-key");
    const launch = f.coordinator.wrapSpawn({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(),
      env: { HOME: "/untrusted", [key]: "override", CLAUDE_CODE_ENTRYPOINT: "sdk-ts" } });
    expect(launch.env.HOME).toBe(f.coordinator.nativeHome.paths.home);
    expect(launch.env[key]).toBe("synthetic-selected-key");
    expect(launch.args.join(" ")).not.toMatch(/bwrap|setpriv|zsr/);
    expect(launch).not.toHaveProperty("cloudNativeHome");
    f.coordinator.cancelUnstartedLaunch(launch);
    const tools = new CloudWorkloadTools(f.lease, f.workload, process.cwd(), f.coordinator.nativeHome);
    const result = await tools.call({ operation: "exec", command: 'printf "%s" "$HOME"' });
    expect(result).toMatchObject({ ok: true, data: { output: f.coordinator.nativeHome.paths.home, exit: { code: 0 } } });
    expect(broker).toHaveBeenCalledWith(expect.objectContaining({ visibleDirectory: path.join(f.coordinator.nativeHome.paths.home, ".zeros-github"),
      identity: fixture.configuration }));
    await tools.stopAndProve(); await f.lease.close();
    expect(await f.workloads.inspect()).toMatchObject({ complete: true, workloadPids: [] });
  });
  it("keeps native transcript state in a plain durable directory before and after whole-scope Stop", async () => {
    const f = await native("cursor"), store = path.join(f.coordinator.nativeHome.paths.cursorHome, "zeros-store");
    const conversationRoot = (await import("node:crypto")).createHash("sha256").update(f.conversationId).digest("hex");
    const durable = path.join(f.dataRoot, "history", conversationRoot, "cursor");
    expect((await lstat(durable)).isSymbolicLink()).toBe(false);
    expect((await lstat(durable)).isDirectory()).toBe(true);
    expect(await realpath(store)).toBe(durable);
    await writeFile(path.join(store, "checkpoints.ndjson"), "native transcript\n");
    expect(await readFile(path.join(durable, "checkpoints.ndjson"), "utf8")).toBe("native transcript\n");
    await f.lease.close();
    expect(await readFile(path.join(f.dataRoot, "history", conversationRoot, "cursor", "checkpoints.ndjson"), "utf8")).toBe("native transcript\n");
    await expect(lstat(f.coordinator.nativeHome.paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("checks the original global fence at native transport handoff without retiring a sibling implicitly", async () => {
    const f = await native("claude"), fence = f.workloads.fence();
    expect(() => f.coordinator.environment()).toThrow();
    expect(() => f.coordinator.wrapSpawn({ command: process.execPath, args: [], cwd: process.cwd(), env: {} })).toThrow();
    await f.workloads.drain(fence); await f.lease.close();
  });
});
