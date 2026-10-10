import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, vi } from "vitest";
import { CloudExecutionBoundary } from "../../../containment/cloud-execution-boundary";
import { createCloudNativeHome } from "../../../containment/cloud-native-home";
import { portableCloudWorkloads } from "../../../containment/__tests__/helpers/portable-cloud-custody";
import { materializeCloudSkills } from "../../../cloud-skills";
import { codexAppServerFeatureArgs } from "../app-server";
import { resolveCodexBinary } from "../binary-resolver";
import { CLOUD_CODEX_CONFIG } from "../cloud-policy";

const configuration = vi.hoisted(() => ({ uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("../../../containment/cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../../../containment/cloud-runtime-root.mjs", async original => ({ ...await original<object>(),
  resolveCloudRuntime: () => ({ cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service" }),
}));

describe.skipIf(process.platform !== "linux")("pinned Codex with physical same-user state (no model request or credentials)", () => {
  it.each(["danger-full-access", "read-only"] as const)("initializes, discovers admitted skills and starts a %s thread under its original owned Host", async sandbox => {
    const binary = await resolveCodexBinary({});
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-codex-physical-"));
    // Real original Host groups/births with explicitly FAKE cgroup IO. This
    // portable pinned RPC check does not qualify deployed UID/custody/entry.
    const workloads = portableCloudWorkloads(configuration);
    try {
      const workspace = path.join(root, "workspace"); await mkdir(workspace);
      const home = await createCloudNativeHome({ dataRoot: root, conversationId: "conversation", provider: "codex", executionId: "native" });
      await materializeCloudSkills(home.paths.directory, [{ name: "zeros-engine-check", description: "Engine check", content: "Reply with ready." }]);
      await mkdir(path.join(home.paths.home, ".agents"), { mode: 0o700 });
      await cp(path.join(home.paths.directory, "skills"), path.join(home.paths.home, ".agents/skills"), { recursive: true });
      const boundary = new CloudExecutionBoundary({ configuration, workloads });
      const prepared = await boundary.prepare({ executionId: randomUUID(), actor: "agent-code", providerId: "codex", cwd: workspace, workspaceRoot: workspace });
      const config = { ...CLOUD_CODEX_CONFIG, sqlite_home: path.join(home.paths.codexHome, "sessions/.zeros-state") };
      const native = await prepared.spawn({ command: path.join(binary.sandboxRuntimeRoot!, "bin/codex"),
        args: ["app-server", ...codexAppServerFeatureArgs(true), ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])],
        cwd: workspace, env: { ...home.environment(), PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
      native.stdin!.on("error", () => {}); native.stderr?.resume();
      const lines = createInterface({ input: native.stdout! });
      const pending = new Map<number, (reply: { result?: unknown; error?: unknown }) => void>();
      lines.on("line", line => { try { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); } catch {} });
      let requestId = 0;
      const call = (method: string, params: unknown) => new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
        const id = ++requestId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Pinned native RPC timed out")); }, 5000);
        pending.set(id, reply => { clearTimeout(timer); resolve(reply); });
        void native.wait().then(() => { clearTimeout(timer); reject(new Error("Pinned native process exited")); }, reject);
        native.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
      });
      try {
        expect(await call("initialize", { clientInfo: { name: "qualification", version: "1" }, capabilities: { experimentalApi: true } }))
          .toMatchObject({ result: { codexHome: home.paths.codexHome } });
        native.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
        const started = await call("thread/start", { model: "gpt-5.6-luna", modelProvider: "openai", cwd: workspace,
          config, sandbox, approvalPolicy: "on-request", experimentalRawEvents: false });
        expect(started.error).toBeUndefined();
        expect(started.result).toMatchObject({ cwd: workspace, approvalPolicy: "on-request",
          sandbox: { type: sandbox === "read-only" ? "readOnly" : "dangerFullAccess" } });
        const listed = await call("skills/list", { cwds: [workspace], forceReload: true });
        expect(listed.error).toBeUndefined();
        const data = (listed.result as { data: { skills: { name: string; path: string }[] }[] }).data;
        expect(data.flatMap(entry => entry.skills).find(skill => skill.name === "zeros-engine-check")?.path)
          .toBe(path.join(home.paths.home, ".agents/skills/zeros-engine-check/SKILL.md"));
        // A physical source root, not a virtual mount or a worker UID. Native
        // full-access/explicit read-only are still ordinary provider policies.
        expect(home.environment().HOME).toBe(home.paths.home);
        expect(home.environment().CODEX_HOME).toBe(home.paths.codexHome);
      } finally { lines.close(); await prepared.stopAndProve(); }
      expect(await workloads.inspect()).toMatchObject({ complete: true, workloadPids: [], pendingLaunches: 0 });
    } finally { await workloads.drain(workloads.fence()); await rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
