import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CloudExecutionBoundary } from "../../agents/containment/cloud-execution-boundary";
import { CloudOwnedWorkloadRegistry } from "../../agents/containment/cloud-owned-workloads";
import { createCloudDesignCaptureHost } from "../capture-cloud";

const configuration = vi.hoisted(() => ({ uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
const deployment = vi.hoisted(() => ({ workerRoot: "" }));
vi.mock("../../agents/containment/cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../../agents/containment/cloud-runtime-root.mjs", () => ({ resolveCloudRuntime: () => ({ profile: "v4", workerRoot: deployment.workerRoot, node: process.execPath }) }));
const roots: string[] = [], registries: CloudOwnedWorkloadRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.drain(registry.fence());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
it("runs a fixed capture worker with engine identity in the shared original registry and preserves its sibling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-capture-owned-")); roots.push(root);
  deployment.workerRoot = root;
  await mkdir(path.join(root, "dist-engine"));
  // Renderer substitution only: the actual cloud Host supervisor and original
  // registry own this child. Browser/PNG qualification remains an image probe.
  await writeFile(path.join(root, "dist-engine/design-capture-worker.js"),
    'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({data:Buffer.from("png").toString("base64"),renderer:"fixture",identity:{uid:process.geteuid(),gid:process.getegid()}})));');
  const workloads = new CloudOwnedWorkloadRegistry(); registries.push(workloads);
  const boundary = new CloudExecutionBoundary({ configuration, workloads });
  const sibling = await boundary.prepare({ executionId: randomUUID(), actor: "agent-code", cwd: root, workspaceRoot: root });
  const siblingChild = await sibling.spawn({ command: process.execPath, args: ["-e", "console.log('ready');setInterval(()=>{},1000)"], cwd: root, env: {} });
  await new Promise<void>(resolve => siblingChild.stdout!.once("data", () => resolve()));
  let captureHome: string | undefined;
  const original = boundary.prepareOwned.bind(boundary);
  vi.spyOn(boundary, "prepareOwned").mockImplementation((request, control) => {
    captureHome = request.cwd;
    return original(request, control);
  });
  const observer = vi.fn((identity: { uid: number; gid: number }) => {
    expect(identity).toEqual({ uid: process.geteuid!(), gid: process.getegid!() });
  });
  const reply = await createCloudDesignCaptureHost(boundary, { onIdentity: observer })({ version: 1, html: "<body></body>", revision: "fixture", width: 1, height: 1, colorScheme: "light" }, new AbortController().signal);
  expect(reply).toEqual({ bytes: Buffer.from("png"), renderer: "fixture" });
  expect(observer).toHaveBeenCalledOnce();
  await expect(access(captureHome!)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await workloads.inspect()).toMatchObject({ complete: true, pendingLaunches: 0, workloadPids: expect.arrayContaining([siblingChild.pid]) });
  expect(workloads.snapshot().scopes).toHaveLength(1);
  await sibling.stopAndProve();
  expect(await workloads.inspect()).toMatchObject({ complete: true, workloadPids: [] });
});
