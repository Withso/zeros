import { resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import { isCloudWorkerConfiguration, type CloudWorkerConfiguration } from "./cloud-worker-config";
import {
  cloudWorkloadEntryDescriptor, inspectCloudWorkloadTree, loadCloudWorkloadCustody, nativeCloudWorkloadIO,
  type CloudDelegatedWorkloadEvidence, type CloudWorkloadCensus, type CloudWorkloadDirectoryIdentity,
  type CloudWorkloadEntry, type CloudWorkloadKernelIO,
} from "./cloud-workload-cgroup.mjs";

export interface CloudWorkloadControllerBirth {
  readonly kind: "engine" | "resident";
  readonly pid: number;
  readonly startToken: string;
}
export interface CloudWorkloadCustody {
  readonly entry: CloudWorkloadEntry;
  readonly controller: CloudWorkloadControllerBirth;
  readonly cpuSplit: unknown;
  assertLive(): void;
  inspect(): CloudWorkloadCensus;
}
interface OriginalCustody {
  readonly configuration: CloudWorkerConfiguration;
  readonly io: CloudWorkloadKernelIO;
  readonly evidence: CloudDelegatedWorkloadEvidence;
  readonly controller: CloudWorkloadControllerBirth;
  readonly control: CloudWorkloadDirectoryIdentity;
}
const originals = new WeakMap<object, OriginalCustody>();
const unavailable = () => Object.assign(new Error("Cloud workload custody is not ready"), {
  code: "cloud_containment_environment_not_ready",
});
export function isCloudWorkloadCustody(value: unknown): value is CloudWorkloadCustody {
  return typeof value === "object" && value !== null && originals.has(value);
}
function original(value: CloudWorkloadCustody): OriginalCustody {
  const source = originals.get(value);
  if (!source) throw unavailable();
  return source;
}
export function cloudWorkloadCustodyConfiguration(value: CloudWorkloadCustody): CloudWorkerConfiguration {
  return original(value).configuration;
}
export function cloudWorkloadCustodyInfrastructure(value: CloudWorkloadCustody): CloudDelegatedWorkloadEvidence["infrastructure"] {
  return original(value).evidence.infrastructure;
}
/** Only explicit fake-kernel unit fixtures omit the native child entry. A
 * production controller always uses native IO and the real pre-exec handoff. */
export function cloudWorkloadHostEntry(value: CloudWorkloadCustody): CloudWorkloadEntry | null {
  return original(value).io === nativeCloudWorkloadIO ? value.entry : null;
}
function assertController(source: OriginalCustody): void {
  const identity = source.io.identity(), member = source.io.process(source.controller.pid);
  const current = source.io.directory(source.control.directory);
  if ([identity.uid, identity.gid, identity.euid, identity.egid].some(value => value !== 10003) ||
    identity.pid !== source.controller.pid || !member || member.uid !== 10003 ||
    member.startToken !== source.controller.startToken || member.directory !== source.control.directory ||
    current.dev !== source.control.dev || current.ino !== source.control.ino || current.filesystem !== 0x63677270)
    throw unavailable();
  for (const expected of [source.evidence.common, source.evidence.workload]) {
    const actual = source.io.directory(expected.directory);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.filesystem !== 0x63677270 ||
      actual.uid !== 10003 || actual.mode & 0o022) throw unavailable();
  }
}
/** Root-projected controller identity, not a renderer PID or environment flag.
 * This client never signals census PIDs and never owns the outside-root final
 * VM kill/receipt. It provides read-only census and child self-entry metadata. */
export function createCloudWorkloadCustody(configuration: CloudWorkerConfiguration,
  options: { readonly io?: CloudWorkloadKernelIO } = {}): CloudWorkloadCustody {
  if (!isCloudWorkerConfiguration(configuration)) throw unavailable();
  const io = options.io ?? nativeCloudWorkloadIO;
  const evidence = loadCloudWorkloadCustody(resolveCloudRuntime().cgroupRoot, io);
  const identity = io.identity(), birth = evidence.infrastructure.find(value => value.pid === identity.pid && value.controlDirectory);
  if (!birth?.controlDirectory) throw unavailable();
  const metadata = io.directory(birth.controlDirectory);
  const controller = Object.freeze({ kind: birth.kind, pid: birth.pid, startToken: birth.startToken });
  const source: OriginalCustody = { configuration, io, evidence, controller,
    control: Object.freeze({ directory: birth.controlDirectory, dev: metadata.dev, ino: metadata.ino }) };
  const client: CloudWorkloadCustody = Object.freeze({ entry: cloudWorkloadEntryDescriptor(evidence), controller,
    cpuSplit: evidence.cpuSplit,
    assertLive() {
      try {
        assertController(source);
      } catch { throw unavailable(); }
    },
    inspect() {
      try {
        assertController(source);
        const census = inspectCloudWorkloadTree(evidence, io);
        if (census.complete && census.infrastructurePids.includes(controller.pid)) return census;
      } catch { /* unknown is busy; it is not a permanently cached failure */ }
      return { complete: false, populated: true, processes: [], workloadPids: [], infrastructurePids: [],
        common: evidence.common, groups: 0, censusSha256: null };
    },
  });
  originals.set(client, source);
  return client;
}
