import { readCloudAgentRuntimeAttestation } from "../../../apps/desktop/src/engine/cloud-runtime-attestation";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chown, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { CloudAgentLease } from "../../../apps/desktop/src/engine/agents/cloud-agent-lease";
import { CloudWorkloadTools } from "../../../apps/desktop/src/engine/agents/cloud-workload-tools";
import { CloudCoordinatorBoundary } from "../../../apps/desktop/src/engine/agents/containment/cloud-coordinator-boundary";
import { CLOUD_NATIVE_HISTORY_ROOT } from "../../../apps/desktop/src/engine/agents/containment/cloud-native-history";
import { loadCloudWorkerConfiguration } from "../../../apps/desktop/src/engine/agents/containment/cloud-worker-config";
import { ZsrExecutionBoundary } from "../../../apps/desktop/src/engine/agents/containment/zsr-boundary";
import type { PreparedBoundary } from "../../../apps/desktop/src/engine/agents/containment/types";
import { CloudRuntimeLanguageServices } from "../../../apps/desktop/src/engine/transport/cloud-language-services";

// Runs only inside the attested image's engine namespace. Authentication here
// is a synthetic lifecycle fixture; no provider SDK, network login or model is
// invoked. Live account admission is a separate end-to-end qualification.
const workspace = "/srv/zeros/workspace";
const conversationId = `image-qualification-${randomUUID()}`;
const prefix = `.zeros-actor-qualification-${randomUUID()}`;
const source = `${prefix}.ts`;
const python = `${prefix}.py`;
const escaped = `${prefix}-escape.ts`;
const design = path.join(workspace, `${prefix}-design`);
const checks: string[] = [];
let phase = "configuration",
  failed = false;
let failureCode: string | undefined;
let workload: PreparedBoundary | undefined;
let lease: CloudAgentLease | undefined;
let languages: CloudRuntimeLanguageServices | undefined;

async function main() {
  const worker = loadCloudWorkerConfiguration();
  assert.equal(worker?.version, 3);
  assert(worker);
  const runtime=readCloudAgentRuntimeAttestation(worker);
  assert.equal(runtime.profile,"zeros-cloud-worker-v3");
  checks.push("immutable-engine-registration-attestation");
  for (const [name, contents] of [
    [source, "export function welcome(name: string) { return name; }\nwel\n"],
    [python, "def welcome(name):\n    return name\n"],
  ]) {
    const file = path.join(workspace, name!);
    await writeFile(file, contents!, { flag: "wx", mode: 0o644 });
    await chown(file, worker.uid, worker.gid);
  }
  await mkdir(design, { mode: 0o755 });
  await chown(design, worker.uid, worker.gid);
  phase = "workload";
  workload = await new ZsrExecutionBoundary({
    projectRoot: workspace,
    supervisorScript: "/opt/zeros/binaries/zsr-supervisor.mjs",
    cloudWorker: worker,
    cloudWorkerToolchain: worker.toolchain,
  }).prepare({
    executionId: randomUUID(),
    actor: "agent-code",
    providerId: "cursor",
    cwd: workspace,
    workspaceRoot: workspace,
    territory: {
      agentRole: "code",
      workspaceRoot: workspace,
      designDirectory: design,
      protectedDesignDirectories: [design],
      designRecognitionPaths: [],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [design, path.join(workspace, ".git")],
      },
    },
  });
  const admission = {
    executionId: randomUUID(),
    delegationId: randomUUID(),
    provider: "cursor" as const,
    model: "grok-4.6",
    source: { kind: "session" as const, actorSessionId: randomUUID() },
  };
  const leaseId = randomUUID();
  lease = await CloudAgentLease.admit(
    admission,
    async (request) =>
      request.kind === "release"
        ? { released: true }
        : {
            leaseId,
            expiresAt: new Date(Date.now() + 45_000).toISOString(),
            credentialVersion: 1,
            ...(request.kind === "admit"
              ? {
                  authorityId: "a".repeat(64),
                  credentialKind: "cursor-api-key",
                  provider: "cursor",
                  model: "grok-4.6",
                  material: {
                    kind: "cursor-api-key",
                    apiKey: "synthetic-image-private-credential",
                  },
                }
              : {}),
          },
    new AbortController().signal,
    {
      onRetirementFailure: () => {
        failed = true;
      },
    },
  );
  lease.attach(workload);
  phase = "private-coordinator";
  const coordinator = await CloudCoordinatorBoundary.prepare(
    lease,
    workload,
    conversationId,
  );
  const probe = await lease.launch(() =>
    coordinator.spawn({
      command: worker.toolchain.node,
      args: [
        "-e",
        `const fs=require('node:fs');
      if(process.getuid()!==10004||process.env.CURSOR_API_KEY!=='synthetic-image-private-credential')process.exit(91);
      if(fs.existsSync(${JSON.stringify(path.join(workspace, source))}))process.exit(92);
      process.stdout.write('private-coordinator-qualified');`,
      ],
      cwd: workspace,
      env: {},
      stdio: "pipe",
    }),
  );
  let output = "";
  probe.stdout?.on("data", (bytes) => {
    if (output.length < 128) output += String(bytes);
  });
  probe.stderr?.resume();
  const [exit] = await Promise.all([
    probe.wait(),
    probe.stdout ? finished(probe.stdout, { cleanup: true }) : undefined,
  ]);
  assert.equal(exit.code, 0);
  assert.equal(output, "private-coordinator-qualified");
  await lease.retire(probe);
  checks.push(
    "credential-private-coordinator-in-engine-namespace",
    "coordinator-cannot-read-worktree",
  );
  phase = "agent-tools";
  const tools = new CloudWorkloadTools(lease, workload, workspace);
  const execution = await tools.call({
    operation: "exec",
    command: `${worker.toolchain.node} -e 'if(process.getuid()!==10001||process.env.CURSOR_API_KEY)process.exit(91);process.stdout.write("workload-qualified")'`,
  });
  assert.equal(execution.ok, true);
  assert.match(JSON.stringify(execution), /workload-qualified/);
  const agentSymbols = await tools.call({
    operation: "lsp",
    request: { kind: "documentSymbols", language: "typescript", path: source },
  });
  assert.equal(agentSymbols.ok, true);
  assert.match(JSON.stringify(agentSymbols), /welcome/);
  checks.push("credential-free-agent-execution", "agent-native-language-tools");
  phase = "human-tools";
  languages = new CloudRuntimeLanguageServices(worker, () => {
    failed = true;
  });
  for (const [language, file] of [
    ["typescript", source],
    ["python", python],
  ] as const) {
    phase = `human-${language}-symbols`;
    const symbols = await languages.request("first", () => true, {
      kind: "documentSymbols",
      language,
      path: file,
    });
    assert.match(JSON.stringify(symbols), /welcome/);
  }
  phase = "human-second-device-open";
  await languages.request("second", () => true, {
    kind: "open",
    language: "typescript",
    path: source,
  });
  await languages.release("first");
  phase = "human-disk-refresh";
  await writeFile(
    path.join(workspace, source),
    "export function changed() { return 1; }\n",
  );
  const changed = await languages.request("second", () => true, {
    kind: "documentSymbols",
    language: "typescript",
    path: source,
  });
  assert.match(JSON.stringify(changed), /changed/);
  phase = "human-symlink-denial";
  await symlink("/etc/passwd", path.join(workspace, escaped));
  await assert.rejects(
    languages.request("second", () => true, {
      kind: "open",
      language: "typescript",
      path: escaped,
    }),
  );
  checks.push(
    "human-typescript-python-tools",
    "independent-device-tool-lifetime",
    "disk-document-refresh",
    "symlink-read-denial",
  );
  phase = "retirement";
  await lease.close();
  await languages.pause();
  assert.equal(failed, false);
  checks.push("all-tool-and-coordinator-processes-retired");
}

main()
  .catch((error: unknown) => {
    failed = true;
    // Only fixed error categories leave the synthetic canary; never source,
    // subprocess output, credentials or filesystem paths.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    failureCode = ["denied", "capacity", "timeout", "output_limit", "unavailable", "ERR_ASSERTION", "EACCES", "EPERM"].includes(String(code)) ? String(code) : "unclassified";
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await lease?.close();
      await languages?.pause();
      await workload?.stopAndProve();
      for (const name of [source, python, escaped, path.basename(design)])
        await rm(path.join(workspace, name), { recursive: true, force: true });
      // This unguessable synthetic conversation has no external callers. Remove
      // only its own test history after both execution domains prove retirement.
      await rm(
        path.join(
          CLOUD_NATIVE_HISTORY_ROOT,
          createHash("sha256").update(conversationId).digest("hex"),
        ),
        { recursive: true, force: true },
      );
    } catch {
      failed = true;
      process.exitCode = 1;
    }
    process.stdout.write(
      JSON.stringify({ secure: !failed, phase, checks, failureCode }) + "\n",
    );
  });
