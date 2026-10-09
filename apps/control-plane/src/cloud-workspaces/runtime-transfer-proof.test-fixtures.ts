import { runtimeWitness } from "./runtime-test-fixtures.js";
import type { CloudActiveRuntime } from "./runtime-contract.js";

export const transferActive: CloudActiveRuntime = {
  ...runtimeWitness,
  schema: "zeros.active-runtime/v1",
  root: `/opt/zeros-infra/${runtimeWitness.runtimeId}`,
  cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service",
};
export const transferResources = { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 };
const deploymentKeys = [
  "runtimeProfile", "engineLauncher", "engineView", "engineCgroup", "runtimeLayout", "resourceInspector", "resourceAdmission",
  "setupProcess", "admissionConsumer", "previewLinkInstaller", "githubCredentialInstaller", "githubRefreshRequestHelper", "gitAskpass",
  "setupHelper", "attester", "engineNamespace", "launcher", "engineQualification", "engineAppArmor", "runtimeTree", "admissionDirectory",
];
const trusted = (keys: string[]) => Object.fromEntries(keys.map(key => [key, true]));
const common = () => ({
  profile: "zeros-cloud-worker-v4", qualified: true, runtime: { ...runtimeWitness },
  resources: { finite: true, cpuMax: "200000 100000", memoryMax: "4294967296", pidsMax: "4096",
    allocation: { cpuMillicores: 2000, memoryBytes: 4294967296, storageBytes: 21474836480 } },
});

/** Archived report reader fixture; new runtimes must never produce this posture. */
export function legacyTransferReport() {
  return { ...common(), version: 1,
    helpers: { trusted: trusted(["node", "bwrap", "setpriv", "supervisor"]),
      deploymentTrusted: trusted([...deploymentKeys, "workerSupervisor"]) },
    qualification: { secure: true, identity: { secure: true, hostUid: 10003, namespaceUid: 0, noNewPrivs: 1, seccompMode: 2 },
      workload: { secure: true }, capture: { secure: true }, humanServices: { secure: true }, actorTools: { secure: true } },
    setupQualification: { secure: true, unprivileged: true, detachedDescendantsRetired: true, timeoutRetired: true },
  };
}

/** Version two proves one non-root engine identity and owned lifecycle. */
export function vmTransferReport() {
  return { ...common(), version: 2, boundary: "workspace-vm",
    resources: { finite: true, cpuMax: "200000 100000" as string | null, memoryMax: "3221225472",
      memoryBudget: { nominalMemoryBytes: "4294967296" as string | null, measuredMemoryBytes: "4294967296" as string | null,
        hostMemoryMax: "1073741824", source: "nominal", capped: false },
      pidsMax: "4096", allocation: common().resources.allocation, cpuSplit: {
      engine: { cpuMax: "max 100000", cpuWeight: 100 },
      workload: { controllers: ["cpu"], cpuWeight: 100,
        cap: { kind: "applied", effectiveCpus: 2, cpuMax: "150000 100000" } },
    } },
    helpers: { trusted: trusted(["node"]), deploymentTrusted: trusted([...deploymentKeys, "hostProcessSupervisor"]) },
    qualification: { identity: { hostUid: 10003, namespaceUid: 10003, noNewPrivs: 1, seccompMode: 2,
      capabilities: { effective: 0, permitted: 0, inheritable: 0, bounding: 0, ambient: 0 } },
      execution: { sameEngineIdentity: true, noSandbox: true, ownedProcessGroups: true,
        originalProcessGroupsRetired: true, timeoutRetired: true, workloadCgroup: true, vmWorkloadDrain: true },
      capture: { sameEngineIdentity: true, chromiumSandbox: true },
      humanServices: { sameEngineIdentity: true, noSandbox: true },
      actorTools: { sameEngineIdentity: true, noSandbox: true } },
    setupQualification: { hostUid: 10003, hostGid: 10003, detachedDescendantsRetired: true, timeoutRetired: true },
  };
}
