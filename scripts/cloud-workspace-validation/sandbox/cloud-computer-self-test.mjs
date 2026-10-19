import { createHash } from "node:crypto";
import { cloudRuntimeResourcesQualified } from "./cloud-resource-admission.mjs";
import { cloudRunnerQualificationPassed } from "./cloud-runner-base.mjs";

// This is build evidence, never a launch proof. The base must verify the full
// installed bytes before invoking this producer; the CP binds its result to
// the exact build, sanitation and saved snapshot before any future reuse.
export const COMPUTER_SELF_TEST_SCHEMA = "zeros.computer-self-test/v1";
export const COMPUTER_SELF_TEST_MAX_BYTES = 64 * 1024;
export const COMPUTER_RUNTIME_CHECKS = Object.freeze([
  "node_abi", "sqlite_query", "pty_load", "claude_version", "codex_version",
  "cursor_load", "engine_load", "supervisor_idle", "engine_lifecycle",
]);
export const COMPUTER_RUNTIME_FIELDS = Object.freeze([
  "runtimeId", "manifestSha256", "installerReceiptSha256", "baseCompatibilityId", "bootId", "supervisorSessionId",
]);
export const COMPUTER_ROLE_CHECKS = Object.freeze({
  identity: Object.freeze([
    "engine-no-new-privileges-and-seccomp", "engine-non-root-empty-capabilities", "fixed-engine-user-namespace",
    "readonly-image-authority", "host-authority-absent", "host-root-authority-denied", "global-kernel-control-writes-denied",
    "host-user-namespace-entry-denied", "readonly-mounts-locked", "inherited-unmount-denied",
    "same-engine-child-shared-files", "finite-engine-and-descendant-resources",
  ]),
  actorTools: Object.freeze([
    "immutable-engine-registration-attestation", "captured-provider-credential-and-engine-identity", "shared-managed-worktree",
    "legacy-workload-bridge-engine-identity", "agent-native-language-tools", "human-typescript-python-tools",
    "independent-device-tool-lifetime", "disk-document-refresh", "symlink-read-denial",
    "original-detached-group-and-non-escaped-descendants-retired", "timeout-original-group-retired",
  ]),
  humanServices: Object.freeze([
    "ssh-in-admitted-engine-view", "ssh-engine-identity", "shared-engine-attachment-staging",
    "same-mount-atomic-attachment-publication", "ssh-exec-output-and-exit", "ssh-exec-and-pty", "ssh-sftp",
    "ssh-original-group-descendants-retired",
  ]),
});
export const COMPUTER_ADDITIONAL_CHECKS = Object.freeze(["setup_process", "final_census", "final_identity"]);
const RESULT_FIELDS = Object.freeze([
  "runtime", "identity", "resources", "mounts", "credentials", "actorTools", "lsps", "capture", "humanServices",
  "setupProcess", "retirement", "census",
]);
const EXECUTION_FIELDS = Object.freeze([
  "sameEngineIdentity", "noSandbox", "ownedProcessGroups", "originalProcessGroupsRetired", "timeoutRetired",
  "workloadCgroup", "vmWorkloadDrain",
]);
const hash = value => createHash("sha256").update(value).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const require = condition => { if (!condition) throw new Error("computer_self_test_incomplete"); };
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
export function canonicalComputerSelfTest(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalComputerSelfTest).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalComputerSelfTest(value[key])}`).join(",")}}`;
}

/** Only the complete fixed vocabulary can cross the role/report boundary.
 * Unknown prose, duplicates and partial results are not reusable evidence. */
export function computerRoleChecks(value, role) {
  const expected = COMPUTER_ROLE_CHECKS[role];
  if (!expected || !Array.isArray(value) || value.length !== expected.length ||
    new Set(value).size !== value.length || value.some(name => !expected.includes(name))) return undefined;
  return [...expected];
}

export function computerSelfTestRuntime(runtime) {
  const value = Object.fromEntries(COMPUTER_RUNTIME_FIELDS.map(key => [key, runtime?.[key]]));
  require(hex(value.manifestSha256) && value.runtimeId === `r1-${value.manifestSha256}` &&
    hex(value.installerReceiptSha256) && typeof value.baseCompatibilityId === "string" &&
    /^bc1-[a-f0-9]{64}$/.test(value.baseCompatibilityId) && uuid(value.bootId) && uuid(value.supervisorSessionId));
  return value;
}

export function computerEngineEvidence(value, requireRunners) {
  require(typeof requireRunners === "boolean" && record(value) && value.version === 2 &&
    value.boundary === "workspace-vm" && value.qualified === true && !Object.hasOwn(value, "engineChecksPassed"));
  const identity = value.identity;
  require(identity?.qualified === true && identity.hostUid === 10003 && identity.namespaceUid === 10003 &&
    identity.noNewPrivs === 1 && identity.seccompMode === 2 &&
    exactKeys(identity.capabilities, ["effective", "permitted", "inheritable", "bounding", "ambient"]) &&
    Object.values(identity.capabilities).every(number => number === 0) && cloudRuntimeResourcesQualified(identity.resources));
  require(Array.isArray(identity.checks) && identity.checks.length === COMPUTER_ROLE_CHECKS.identity.length &&
    identity.checks.every(check => exactKeys(check, ["name", "status"]) && check.status === "pass"));
  const checks = { identity: computerRoleChecks(identity.checks.map(check => check.name), "identity"),
    actorTools: computerRoleChecks(value.actorTools?.buildChecks, "actorTools"),
    humanServices: computerRoleChecks(value.humanServices?.buildChecks, "humanServices") };
  require(Object.values(checks).every(Boolean) && EXECUTION_FIELDS.every(key => value.execution?.[key] === true) &&
    !Object.hasOwn(value.execution, "detachedDescendantsRetired") && value.capture?.sameEngineIdentity === true &&
    value.capture.chromiumSandbox === true && ["actorTools", "humanServices"].every(key =>
      value[key]?.sameEngineIdentity === true && value[key]?.noSandbox === true));
  require(requireRunners ? cloudRunnerQualificationPassed(value.runners) : !Object.hasOwn(value, "runners"));
  return checks;
}

export function computerSetupEvidence(value) {
  return exactKeys(value, ["hostUid", "hostGid", "detachedDescendantsRetired", "timeoutRetired"]) &&
    value.hostUid === 10003 && value.hostGid === 10003 && value.detachedDescendantsRetired === true && value.timeoutRetired === true;
}

function policy(requireRunners) {
  return { version: 1, sha256: hash(canonicalComputerSelfTest({ schema: COMPUTER_SELF_TEST_SCHEMA,
    runtime: COMPUTER_RUNTIME_CHECKS, roles: COMPUTER_ROLE_CHECKS, final: COMPUTER_ADDITIONAL_CHECKS, results: RESULT_FIELDS,
    ...(requireRunners ? { runnerVersion: 1 } : {}) })), ...(requireRunners ? { runnerVersion: 1 } : {}) };
}

export function computerSelfTestReport({ runtime, requireRunners, resourcePolicySha256, checks, now }) {
  require(hex(resourcePolicySha256) && typeof requireRunners === "boolean" && exactKeys(checks, Object.keys(COMPUTER_ROLE_CHECKS)));
  for (const role of Object.keys(COMPUTER_ROLE_CHECKS)) require(computerRoleChecks(checks[role], role));
  require(Number.isSafeInteger(now) && now > 0);
  return { schema: COMPUTER_SELF_TEST_SCHEMA, runtime: computerSelfTestRuntime(runtime),
    policy: { ...policy(requireRunners), resourcePolicySha256 },
    results: { ...Object.fromEntries(RESULT_FIELDS.map(key => [key, true])), ...(requireRunners ? { runner: true } : {}) },
    checks: Object.fromEntries(Object.keys(COMPUTER_ROLE_CHECKS).map(role => [role, [...checks[role]]])),
    qualifiedAt: new Date(now).toISOString() };
}

export function parseComputerSelfTestReport(value) {
  try {
    require(exactKeys(value, ["schema", "runtime", "policy", "results", "checks", "qualifiedAt"]) && value.schema === COMPUTER_SELF_TEST_SCHEMA);
    require(exactKeys(value.runtime, COMPUTER_RUNTIME_FIELDS) && record(value.policy) && record(value.results));
    const requireRunners = Object.hasOwn(value.policy, "runnerVersion");
    require(exactKeys(value.policy, ["version", "sha256", "resourcePolicySha256", ...(requireRunners ? ["runnerVersion"] : [])]) &&
      exactKeys(value.results, [...RESULT_FIELDS, ...(requireRunners ? ["runner"] : [])]));
    const expected = computerSelfTestReport({ ...value, requireRunners,
      resourcePolicySha256: value.policy.resourcePolicySha256, now: Date.parse(value.qualifiedAt) });
    require(canonicalComputerSelfTest(value) === canonicalComputerSelfTest(expected));
    return expected;
  } catch { return null; }
}
