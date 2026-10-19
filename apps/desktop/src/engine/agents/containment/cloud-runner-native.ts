import { execFile } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { assertCloudRunnerRetired, freezeCloudRunnerValue, parseCloudRunnerProof,
  type CloudRunnerIntent, type CloudRunnerProof, type CloudRunnerRetirement, type CloudRunnerScope } from "./cloud-runner-contract";
import { nativeCloudWorkloadIO, type CloudWorkloadKernelIO } from "./cloud-workload-cgroup.mjs";
import type { CloudWorkloadCustody } from "./cloud-workload-custody";

export interface CloudRunnerManagerProof {
  version: 1;
  launcher: { pid: number; startToken: string };
  manager: { pid: number; startToken: string };
  group: CloudRunnerScope["workload"];
  executable: { dev: string; ino: string };
}
const unavailable = () => new Error("cloud_runner_native_unavailable");
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const decimal = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const birth = (value: unknown): value is CloudRunnerManagerProof["manager"] => exact(value, ["pid", "startToken"]) &&
  Number.isSafeInteger(value.pid) && Number(value.pid) > 1 && Number(value.pid) <= 2147483647 && decimal(value.startToken);

/** Independently cross-check the launcher's non-authoritative readiness hint
 * against the original Host supervisor, current kernel and protected binary. */
export function verifyCloudRunnerManager(value: unknown, expected: { scope: Omit<CloudRunnerScope, "executionId">;
  supervisor: { pid: number; startToken: string }; executable: { dev: string; ino: string } },
  io: CloudWorkloadKernelIO = nativeCloudWorkloadIO): CloudRunnerManagerProof {
  if (!exact(value, ["version", "launcher", "manager", "group", "executable"]) || value.version !== 1 ||
    !birth(value.launcher) || !birth(value.manager) || !exact(value.group, ["directory", "dev", "ino"]) ||
    value.group.directory !== `${expected.scope.workload.directory}/runner-${expected.scope.bootId}` ||
    value.group.dev !== expected.scope.workload.dev || !decimal(value.group.ino) ||
    value.group.ino === expected.scope.workload.ino || !isDeepStrictEqual(value.executable, expected.executable)) throw unavailable();
  const proof = value as unknown as CloudRunnerManagerProof;
  const supervisor = io.process(expected.supervisor.pid), manager = io.process(proof.manager.pid);
  const group = io.directory(proof.group.directory);
  if (!supervisor || supervisor.startToken !== expected.supervisor.startToken || supervisor.parent !== expected.scope.owner.pid ||
    supervisor.uid !== 10003 || supervisor.directory !== expected.scope.workload.directory ||
    !isDeepStrictEqual(proof.launcher, proof.manager) || !manager || manager.startToken !== proof.manager.startToken ||
    manager.parent !== supervisor.pid || manager.uid !== 10003 || manager.directory !== `${proof.group.directory}/init.scope` ||
    !isDeepStrictEqual(manager.executable, expected.executable) || group.dev !== proof.group.dev || group.ino !== proof.group.ino ||
    group.filesystem !== 0x63677270 || group.uid !== 10003 || group.mode & 0o077) throw unavailable();
  return freezeCloudRunnerValue(proof);
}

/** Every operation uses the private peer-checked bus. execFile joins its
 * original child on timeout/error; no shell, ambient environment or session
 * bus fallback is available. The helper never forks a provider itself. */
export function executeCloudRunnerNative(command: string, args: readonly string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      timeout: 16_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (error) { reject(unavailable()); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(unavailable()); }
    });
  });
}

export class CloudRunnerNativeClient {
  private readonly flights = new Set<Promise<unknown>>();
  constructor(private readonly options: { directory: string; scope: Omit<CloudRunnerScope, "executionId">;
    proof: CloudRunnerManagerProof; custody: CloudWorkloadCustody; assertManager(): void;
    execute?: typeof executeCloudRunnerNative }) {}
  get pending(): number { return this.flights.size; }
  arguments(executionId: string): string[] {
    this.options.custody.assertLive(); this.options.assertManager();
    const { directory, proof, scope } = this.options;
    return [directory, String(proof.manager.pid), proof.manager.startToken, proof.group.dev, proof.group.ino,
      String(scope.owner.pid), scope.owner.startToken, scope.bootId, scope.runtimeId, executionId, scope.workload.dev, scope.workload.ino];
  }
  private async operation(mode: "ping" | "inspect" | "stop", intent: CloudRunnerIntent): Promise<unknown> {
    const { executionId, ...scope } = intent.scope;
    if (!isDeepStrictEqual(scope, this.options.scope) || this.flights.size >= 32) throw unavailable();
    const args = this.arguments(executionId);
    const flight = (this.options.execute ?? executeCloudRunnerNative)(`/opt/zeros-infra/${scope.runtimeId}/bin/cloud-runner-bus`,
      [mode, ...args.slice(0, 10), intent.attemptId, ...args.slice(10)]);
    this.flights.add(flight);
    try { const value = await flight; this.options.custody.assertLive(); this.options.assertManager(); return value; }
    finally { this.flights.delete(flight); }
  }
  async ping(): Promise<void> {
    const { randomUUID } = await import("node:crypto");
    const value = await this.operation("ping", { version: 1, attemptId: randomUUID(), scope: { ...this.options.scope, executionId: randomUUID() } });
    if (!exact(value, ["ready"]) || value.ready !== true) throw unavailable();
  }
  async inspect(intent: CloudRunnerIntent): Promise<{ state: "running" | "exited"; proof: CloudRunnerProof }> {
    const value = await this.operation("inspect", intent);
    if (!exact(value, ["state", "proof"]) || value.state !== "running" && value.state !== "exited") throw unavailable();
    return { state: value.state, proof: parseCloudRunnerProof(value.proof, intent) };
  }
  async retire(intent: CloudRunnerIntent, proof: CloudRunnerProof | null): Promise<CloudRunnerRetirement> {
    const value = await this.operation("stop", intent);
    assertCloudRunnerRetired(value, intent, proof);
    return value as CloudRunnerRetirement;
  }
  async join(): Promise<void> { await Promise.allSettled([...this.flights]); }
}
