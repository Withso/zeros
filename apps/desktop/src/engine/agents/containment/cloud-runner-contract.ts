import path from "node:path";
import { isCloudRuntimeCgroupRoot } from "./cloud-runtime-root.mjs";

export interface CloudRunnerScope {
  version: 1; organizationId: string; workspaceId: string; generation: number;
  engineInstanceId: string; bootId: string; writerEpoch: string; executionId: string; runtimeId: string;
  owner: { pid: number; startToken: string };
  workload: { directory: string; dev: string; ino: string };
}
export interface CloudRunnerIntent { version: 1; attemptId: string; scope: CloudRunnerScope }
export interface CloudRunnerProof {
  version: 1; attemptId: string; bootId: string; unit: string; invocationId: string;
  pid: number; startToken: string; cgroup: { directory: string; dev: string; ino: string };
}
export interface CloudRunnerRetirement {
  version: 1; attemptId: string; bootId: string; unit: string; invocationId: string;
  originalStartSettled: boolean; originalProcessGone: boolean;
  cgroup: CloudRunnerProof["cgroup"]; complete: boolean; populated: boolean;
}
export interface CloudRunnerCensusExpectation {
  scope: Omit<CloudRunnerScope, "executionId">;
  challengeId: string;
  revision: number;
}
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const decimal = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const identity = (value: unknown): value is CloudRunnerProof["cgroup"] => exact(value, ["directory", "dev", "ino"]) &&
  typeof value.directory === "string" && value.directory.length <= 4096 && !/[\0\r\n]/.test(value.directory) &&
  path.posix.isAbsolute(value.directory) && path.posix.normalize(value.directory) === value.directory &&
  decimal(value.dev) && decimal(value.ino);
const unavailable = () => new Error("cloud_runner_authority_unavailable");
export function freezeCloudRunnerValue<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => {
    if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
  };
  freeze(copy); return copy;
}

/** Dormant service policy. The qualified native backend supplies ONLY its
 * pinned runner entrypoint and places the unit within the original workload
 * subtree. No arbitrary command, Environment, unit property or credentials
 * belong in a StartTransientUnit request. Nothing installs/starts a unit here. */
export function cloudRunnerUnit(executionId: string) {
  if (!uuid(executionId)) throw unavailable();
  return freezeCloudRunnerValue({ version: 1 as const, unit: `zeros-agent-runner@${executionId}.service`,
    entrypoint: "zeros.cloud-agent-runner/v1" as const,
    properties: { Type: "exec", User: "10003", Group: "10003", UMask: "0077", Restart: "no",
      KillMode: "control-group", SendSIGKILL: true, TimeoutStartSec: 10, TimeoutStopSec: 10,
      StandardInput: "null", StandardOutput: "null", StandardError: "null" } });
}

const ownerScopeKeys = ["version", "organizationId", "workspaceId", "generation", "engineInstanceId", "bootId",
  "writerEpoch", "runtimeId", "owner", "workload"] as const;
function ownerScope(value: unknown): value is CloudRunnerCensusExpectation["scope"] {
  if (!exact(value, ownerScopeKeys) || value.version !== 1 ||
    ![value.organizationId, value.workspaceId, value.engineInstanceId, value.bootId, value.writerEpoch].every(uuid) ||
    !natural(value.generation) || typeof value.runtimeId !== "string" || !/^r1-[a-f0-9]{64}$/.test(value.runtimeId) ||
    !exact(value.owner, ["pid", "startToken"]) || !natural(value.owner.pid) || !decimal(value.owner.startToken) || !identity(value.workload)) return false;
  const suffix = "/engine-runtime/engine-workload-shared/workload";
  return value.workload.directory.endsWith(suffix) && isCloudRuntimeCgroupRoot(value.workload.directory.slice(0, -suffix.length));
}
export function parseCloudRunnerScope(value: unknown): CloudRunnerScope {
  if (!exact(value, [...ownerScopeKeys, "executionId"]) || !uuid(value.executionId)) throw unavailable();
  const { executionId, ...scope } = value;
  if (!ownerScope(scope)) throw unavailable();
  return freezeCloudRunnerValue({ ...scope, executionId });
}

function unitIdentity(value: Record<string, unknown>, intent: CloudRunnerIntent) {
  const root = intent.scope.workload;
  return value.version === 1 && value.attemptId === intent.attemptId && value.bootId === intent.scope.bootId &&
    value.unit === cloudRunnerUnit(intent.scope.executionId).unit && typeof value.invocationId === "string" &&
    /^[a-f0-9]{32}$/.test(value.invocationId) && identity(value.cgroup) && value.cgroup.dev === root.dev &&
    value.cgroup.ino !== root.ino && value.cgroup.directory.startsWith(`${root.directory}/`) &&
    value.cgroup.directory.endsWith(`/${value.unit}`);
}
function sameUnit(a: CloudRunnerProof | CloudRunnerRetirement, b: CloudRunnerProof) {
  return a.invocationId === b.invocationId && a.cgroup.directory === b.cgroup.directory &&
    a.cgroup.dev === b.cgroup.dev && a.cgroup.ino === b.cgroup.ino;
}
/** The backend must independently read systemd + kernel custody. A runner's
 * self-reported hello or a PID supplied by a caller is never this proof. */
export function parseCloudRunnerProof(value: unknown, intent: CloudRunnerIntent, previous?: CloudRunnerProof): CloudRunnerProof {
  if (!exact(value, ["version", "attemptId", "bootId", "unit", "invocationId", "pid", "startToken", "cgroup"]) ||
    !unitIdentity(value, intent) || !natural(value.pid) || !decimal(value.startToken)) throw unavailable();
  const proof = value as unknown as CloudRunnerProof;
  if (previous && (!sameUnit(proof, previous) || proof.pid !== previous.pid || proof.startToken !== previous.startToken)) throw unavailable();
  return freezeCloudRunnerValue(proof);
}
export function assertCloudRunnerRetired(value: unknown, intent: CloudRunnerIntent, previous: CloudRunnerProof | null): void {
  if (!exact(value, ["version", "attemptId", "bootId", "unit", "invocationId", "originalStartSettled", "originalProcessGone", "cgroup", "complete", "populated"]) ||
    !unitIdentity(value, intent) || value.originalStartSettled !== true || value.originalProcessGone !== true ||
    value.complete !== true || value.populated !== false || previous && !sameUnit(value as unknown as CloudRunnerRetirement, previous))
    throw new Error("cloud_runner_retirement_unproven");
}

/** This adds a runner veto; it never substitutes for the full existing Host
 * census. The caller supplies a fresh challenge and its current registry
 * revision; a result from before an owner change/start/retirement is unusable.
 * Escaped cgroup members remain busy until the root workspace drain. */
export function cloudRunnerCensusIsQuiet(value: unknown, expected?: CloudRunnerCensusExpectation): boolean {
  if (!exact(expected, ["scope", "challengeId", "revision"]) || !ownerScope(expected.scope) ||
    !uuid(expected.challengeId) || !Number.isSafeInteger(expected.revision) || expected.revision < 0 ||
    !exact(value, ["version", "scope", "challengeId", "revision", "complete", "activeUnits", "pendingStarts", "failedRetirements", "outsideUnitPids"]) ||
    !ownerScope(value.scope) || value.challengeId !== expected.challengeId || value.revision !== expected.revision) return false;
  const a = value.scope, b = expected.scope;
  return ownerScopeKeys.every(key => key === "owner" ? a.owner.pid === b.owner.pid && a.owner.startToken === b.owner.startToken :
    key === "workload" ? a.workload.directory === b.workload.directory && a.workload.dev === b.workload.dev && a.workload.ino === b.workload.ino :
    a[key] === b[key]) &&
    value.version === 1 && value.complete === true && value.activeUnits === 0 && value.pendingStarts === 0 &&
    value.failedRetirements === 0 && Array.isArray(value.outsideUnitPids) && value.outsideUnitPids.length === 0;
}
