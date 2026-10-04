/** The structural §20 builder-VM contract. C3 does not implement SSH or Boat
 * allocation: the B7 cloud-builder-vm adapter is injected by the entrypoint. */
export type BuilderVm = {
  sandboxId: string;
  purpose: "runtime-qualification" | "computer-build";
  operationKey: string;
};
export type BuilderFixedCommand =
  | "install-runtime"
  | "runtime-self-test"
  | `computer:${string}`;
export type ClosedDiagnostic = {
  schema: "zeros.diagnostic/v1";
  component: string;
  stage: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  failedChecks: string[];
};
export interface CloudBuilderVms {
  create(input: {
    purpose: BuilderVm["purpose"];
    source:
      | { kind: "base"; baseImageId: string }
      | { kind: "template"; templateId: string };
    name: string;
    operationKey: string;
    ttlSeconds: number;
  }): Promise<BuilderVm>;
  baseStatus(
    vm: BuilderVm,
  ): Promise<{
    schema: "zeros.base-status/v1";
    baseCompatibilityId: string;
    bootId: string;
    currentRuntimeId: string | null;
    hostState: "idle" | "waiting_for_runtime" | "stopped" | "failed";
  }>;
  runFixed(
    vm: BuilderVm,
    command: BuilderFixedCommand,
    input?: Buffer,
    opts?: { timeoutMs?: number },
  ): Promise<{
    exitCode: number;
    stdout: string;
    diagnostic: ClosedDiagnostic | null;
  }>;
  stop(vm: BuilderVm): Promise<{ archived: true }>;
  delete(vm: BuilderVm): Promise<void>;
}
export type ComputerTemplateRuntime = {
  baseImageId: string;
  baseCompatibilityId: string;
  objectKey: string;
  descriptor: {
    runtimeId: string;
    manifestSha256: string;
    archiveSha256: string;
    archiveBytes: number;
    expandedBytes: number;
    sourceCommit: string;
    nodeModulesAbi: number;
    bootstrapProtocolVersion: 1;
    engineProtocolVersion: number;
  };
};

/** Registration for B7's closed fixed-command allowlist. No input is ever
 * interpolated into these commands; all documents arrive on pinned SSH stdin. */
export const COMPUTER_TEMPLATE_FIXED_COMMANDS = {
  "computer:clone-repos":
    "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/computer-build.py clone-repos",
  "computer:run-install":
    "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/computer-build.py run-install",
  "computer:verify-tcb":
    "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/computer-build.py verify-tcb",
  "computer:sanitize":
    "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/computer-build.py sanitize",
} as const;
