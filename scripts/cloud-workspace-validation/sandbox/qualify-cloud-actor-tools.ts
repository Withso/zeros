
import { readCloudAgentRuntimeAttestation } from "../../../apps/desktop/src/engine/cloud-runtime-attestation";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chown, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import { CloudAgentLease } from "../../../apps/desktop/src/engine/agents/cloud-agent-lease";
import { CloudWorkloadTools } from "../../../apps/desktop/src/engine/agents/cloud-workload-tools";
import { CloudNativeBoundary } from "../../../apps/desktop/src/engine/agents/containment/cloud-native-boundary";
import { CLOUD_NATIVE_HISTORY_ROOT } from "../../../apps/desktop/src/engine/agents/containment/cloud-native-history";
import { createCloudQualificationRuntime, type CloudQualificationRuntime } from "./cloud-qualification-runtime";
import { cloudRoleIdentityProbe } from "./cloud-role-identity";

import type { PreparedBoundary } from "../../../apps/desktop/src/engine/agents/containment/types";
import { CloudRuntimeLanguageServices } from "../../../apps/desktop/src/engine/transport/cloud-language-services";

// Runs only inside the attested image's engine namespace. Authentication here
// is a synthetic lifecycle fixture; no provider SDK, network login or model is
// invoked. Live account admission is a separate end-to-end qualification.
export async function qualifyCloudActorTools(context: CloudQualificationRuntime = createCloudQualificationRuntime()) {
const { configuration: worker, boundary, workloads: owned, custody } = context;
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
let identityObserved = false, groupsObserved = false, descendantsRetired = false, timeoutRetired = false;

async function main() {
  custody.assertLive();
  assert(worker?.version === 4);
  assert(worker);
  const runtime=readCloudAgentRuntimeAttestation(worker);
  assert.equal(runtime.profile,worker.profile);
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
  const executionId = randomUUID();
  workload = await boundary.prepare({ executionId, actor: "agent-code", providerId: "cursor", cwd: workspace, workspaceRoot: workspace });
  const admission = {
    executionId,
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
  phase = "native-home";
  const coordinator = await CloudNativeBoundary.prepare(
    lease,
    workload,
    conversationId,
  );
  const probe = await lease.launch(() =>
    coordinator.spawn({
      command: worker.toolchain.node,
      args: [
        "-e",
        cloudRoleIdentityProbe({ workloadDirectory: custody.entry.workload.directory, home: coordinator.nativeHome.paths.home, credential: "synthetic-cursor" }) +
        `const fs=require('node:fs');
      if(!fs.readFileSync(${JSON.stringify(path.join(workspace, source))},'utf8').includes('welcome'))process.exit(92);
      process.stdout.write('shared-native-home-qualified');`,
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
  assert.equal(output, "shared-native-home-qualified");
  await lease.retire(probe);
  identityObserved = true;
  checks.push("captured-provider-credential-and-engine-identity", "shared-managed-worktree");
  phase = "agent-tools";
  const tools = new CloudWorkloadTools(lease, workload, workspace, coordinator.nativeHome);
  const toolProbe = cloudRoleIdentityProbe({ workloadDirectory: custody.entry.workload.directory, home: coordinator.nativeHome.paths.home, credential: "absent" }) + 'process.stdout.write("workload-qualified");';
  const execution = await tools.call({
    operation: "exec",
    command: `'${worker.toolchain.node.replaceAll("'", "'\\''")}' -e '${toolProbe.replaceAll("'", "'\\''")}'`,
  });
  assert.equal(execution.ok, true);
  assert.match(JSON.stringify(execution), /workload-qualified/);
  const agentSymbols = await tools.call({
    operation: "lsp",
    request: { kind: "documentSymbols", language: "typescript", path: source },
  });
  assert.equal(agentSymbols.ok, true);
  assert.match(JSON.stringify(agentSymbols), /welcome/);
  checks.push("legacy-workload-bridge-engine-identity", "agent-native-language-tools");
  phase = "human-tools";
  languages = new CloudRuntimeLanguageServices(worker, () => {
    failed = true;
  }, boundary);
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
  phase = "owned-group-retirement";
  const marker = path.join(workspace, `${prefix}-owned-group`);
  const child = await workload.spawn({command: worker.toolchain.node, args: ["-e",
    `const fs=require('node:fs'),{spawn}=require('node:child_process');
     spawn(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(" + JSON.stringify(marker) + ",'x'),20);")}],{stdio:'ignore'});
     process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`], cwd: workspace, env: {PATH:"/usr/bin:/bin",HOME:"/tmp"},stdio:"pipe"});
  child.stderr?.resume(); child.stdout?.resume();
  groupsObserved = owned.snapshot().scopes.some(scope => scope.executionId === executionId && scope.processGroups.includes(child.pid));
  assert(groupsObserved);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { try { if ((await readFile(marker)).length) break; } catch {} await new Promise(resolve=>setTimeout(resolve,20)); }
  assert((await readFile(marker)).length > 0);
  await lease.close();
  const before = await readFile(marker,"utf8");
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(await readFile(marker,"utf8"),before);
  descendantsRetired = true;
  await languages.pause();
  await rm(marker, {force:true});
  phase = "timeout-retirement";
  const timeout = AbortSignal.timeout(250);
  const timed = await boundary.prepare({executionId:randomUUID(),actor:"repo-code-task",providerId:"timeout-probe",cwd:workspace,workspaceRoot:workspace},{signal:timeout});
  try {
    const process = await timed.spawn({command:worker.toolchain.node,args:["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],cwd:workspace,env:{PATH:"/usr/bin:/bin",HOME:"/tmp"},stdio:"pipe"});
    process.stdout?.resume(); process.stderr?.resume();
    if (!timeout.aborted) await new Promise<void>(resolve=>timeout.addEventListener("abort",()=>resolve(),{once:true}));
  } finally { await timed.stopAndProve(); }
  const inspection = await owned.inspect();
  assert(inspection.complete && !inspection.pendingLaunches && !inspection.failedRetirements && !inspection.workloadPids.length);
  custody.assertLive();
  timeoutRetired = true;
  assert.equal(failed, false);
  checks.push("original-detached-group-and-non-escaped-descendants-retired", "timeout-original-group-retired");

}

await main()
  .catch((error: unknown) => {
    failed = true;
    // Only fixed error categories leave the synthetic canary; never source,
    // subprocess output, credentials or filesystem paths.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    failureCode = typeof code === "string" && ["denied", "capacity", "timeout", "output_limit", "unavailable", "ERR_ASSERTION", "EACCES", "EPERM"].includes(code) ? code : "unclassified";
  })
  .finally(async () => {
    try {
      await lease?.close();
      await languages?.pause();
      await workload?.stopAndProve();
      for (const name of [source, python, escaped, `${prefix}-owned-group`, path.basename(design)])
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
    }
  });
return { execution:{sameEngineIdentity: !failed && identityObserved, noSandbox: !failed && identityObserved,
  ownedProcessGroups: !failed && groupsObserved, originalProcessGroupsRetired: !failed && descendantsRetired,
  timeoutRetired: !failed && timeoutRetired, workloadCgroup: !failed && identityObserved, vmWorkloadDrain: false},
  actorTools:{sameEngineIdentity: !failed && identityObserved, noSandbox: !failed && identityObserved}, phase, checks, failureCode };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  qualifyCloudActorTools().then(report => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.execution.sameEngineIdentity || !report.execution.originalProcessGroupsRetired || !report.execution.timeoutRetired) process.exitCode = 1;
  }).catch(() => { process.stdout.write(`${JSON.stringify({ execution: null, actorTools: null })}\n`); process.exitCode = 1; });
}
