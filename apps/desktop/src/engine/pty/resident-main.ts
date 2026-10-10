import { readFileSync } from "node:fs";
import { ResidentPtyHost } from "./resident-host";
import {resolveCloudRuntimeChild} from "../agents/containment/cloud-runtime-root.mjs";
import { runResidentControl } from "./resident-control";
import { assertResidentEngineIdentity } from "./resident-engine-identity";
import {loadCloudWorkerConfiguration} from "../agents/containment/cloud-worker-config";
import {createCloudWorkloadCustody} from "../agents/containment/cloud-workload-custody";

// This entry is selected only by the v4 native namespace helper. It cannot
// turn a local desktop, ambient environment or arbitrary CLI into a PTY broker.
async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("Resident namespace required");
  assertResidentEngineIdentity({platform: process.platform, uid: process.geteuid?.(), gid: process.getegid?.(), groups: process.getgroups?.()});
  process.umask(0o077);
  const stop = () => process.stdin.destroy();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    await runResidentControl(process.stdin, process.stdout, identity => {
      const membership = readFileSync("/proc/self/cgroup", "utf8").trim();
      if (!membership.startsWith("0::/") || membership.includes("\n") ||
        !membership.endsWith(`/engine-workload-${identity.hostId}`))
        throw new Error("Resident scope required");
      const runtime=resolveCloudRuntimeChild();
      const configuration=loadCloudWorkerConfiguration();
      if(!configuration)throw new Error("Resident deployment required");
      const custody=createCloudWorkloadCustody(configuration);
      if(custody.controller.kind!=="resident")throw new Error("Resident controller required");
      return new ResidentPtyHost({ ...identity,projectRoot:runtime.workerRoot,supervisorRuntime:runtime.node,
        supervisorScript:`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`, root: "/srv/zeros/workspace",
        // Fixed roots already projected by the qualified cloud view. The
        // engine additionally resolves each cwd through its managed registry.
        additionalRoots: ["/srv/zeros/repos", "/srv/zeros/state/workspaces", "/srv/zeros/state/design workspaces", "/srv/zeros/state/worktrees"],
        socketPath: `/run/zeros/resident-${identity.hostId}.sock`, shell: "/bin/bash",
        identity: { uid: process.geteuid!(), gid: process.getegid!() },custody });
    });
  } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

main().catch(() => {
  process.stderr.write("Resident workload host stopped\n");
  process.exitCode = 125;
});
