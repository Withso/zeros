import { createHash, randomUUID } from "node:crypto";
import { HarnessFailure } from "./assertions";
import { assertPrivatePidNamespace } from "./fixture-scope";

export function assertPrivateNamespace({ outer, current, uid }: { outer: string; current: string; uid: number }): void {
  if (!/^mnt:\[\d+\]$/.test(outer) || !/^mnt:\[\d+\]$/.test(current) || outer === current)
    throw new HarnessFailure("private_mount_namespace_required");
  if (uid !== 0) throw new HarnessFailure("namespace_root_required");
}
export function assertPrivateRoot(filesystemType: number) {
  if (filesystemType !== 0x01021994) throw new HarnessFailure("private_root_required");
}
type ProcObservation = { uid: number; mountNamespace: string; pidNamespace: string; pid: number;
  rootType: number; procType: number; initNamespace: string };
/** The inherited parent proc is real but describes the parent's PID namespace.
 * Mount fresh proc only inside the guarded private root, then prove PID1 is
 * our own init before process enumeration or retirement can use this view. */
export function preparePrivateProcView(outer: { mountNamespace: string; pidNamespace: string },
  io: { observe(): ProcObservation; mountProc(): void }) {
  const verify = (view: ProcObservation) => {
    assertPrivateNamespace({ outer: outer.mountNamespace, current: view.mountNamespace, uid: view.uid });
    assertPrivatePidNamespace(outer.pidNamespace, view.pidNamespace, view.pid);
    assertPrivateRoot(view.rootType);
    if (view.procType !== 0x9fa0) throw new HarnessFailure("private_proc_view_required");
  };
  const before = io.observe(); verify(before);
  io.mountProc();
  const after = io.observe(); verify(after);
  if (after.mountNamespace !== before.mountNamespace || after.pidNamespace !== before.pidNamespace ||
    after.initNamespace !== after.pidNamespace) throw new HarnessFailure("private_proc_view_required");
  return { filesystemType: after.procType, ownPid1: true as const };
}
export function hostActiveFileOptions() { return { mode: 0o600 }; }
/** Constructor contract only. Actor admission uses the fixture CP verifier;
 * this random private token is never used to bypass that verifier. */
export function fixtureTransportToken() { return `fixture-transport-${randomUUID()}-${randomUUID()}`; }
export function fixtureOuterArguments(sourceRoot: string, node: string, entry: string, config: string, linuxRoot?: string) {
  return ["--unshare-pid", "--as-pid-1", "--cap-add", "ALL", "--ro-bind", linuxRoot ? `${linuxRoot}/usr` : "/usr", "/usr",
    "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--ro-bind", linuxRoot ? `${linuxRoot}/etc` : "/etc", "/etc", "--ro-bind", "/vercel", "/vercel", "--ro-bind", sourceRoot, sourceRoot,
    "--ro-bind", "/sys", "/sys", "--bind", "/sys/fs/cgroup", "/sys/fs/cgroup",
    // The sudo unshare parent already mounted private, unmasked real proc.
    // Bubblewrap --proc locks child mounts and prevents the worker's later
    // nested proc mount after its less privileged user-namespace transition.
    "--bind", "/proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/opt", "--dir", "/srv", "--dir", "/run",
    "--chdir", sourceRoot, "--", node, entry, config];
}
export function fixtureFacade(runtimeId: string): Record<string, string> {
  if (!/^r1-[a-f0-9]{64}$/.test(runtimeId)) throw new HarnessFailure("fixture_contract_invalid");
  return { "/zeros": "/opt/zeros", "/opt/zeros/current": `../zeros-infra/${runtimeId}`, "/opt/zeros/bin": "current/bin",
    "/opt/zeros/worker": "current/worker", "/opt/zeros/manifest.json": "current/manifest.json", "/opt/zeros/logs": "/srv/zeros/log", "/opt/zeros/state": "/srv/zeros/state" };
}
export function fixtureMountPlan() {
  return ["/opt", "/etc", "/run", "/srv"].flatMap(parent => [
    { kind: "tmpfs" as const, target: parent },
    ...(parent === "/opt" ? ["/opt/zeros-infra", "/opt/zeros"] : [`${parent}/zeros`])
      .flatMap(target => [{ kind: "mkdir" as const, target }, { kind: "tmpfs" as const, target }]),
  ]);
}
export function fixtureDescriptor(manifestSha256: string, cgroupRoot = "/sys/fs/cgroup/zeros-agent-e2e/zeros-host.service") {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw new HarnessFailure("fixture_contract_invalid");
  const runtimeId = `r1-${manifestSha256}`;
  return {
    evidenceKind: "source_mode_fixture" as const,
    uidMap: [[0, 10003, 1], [10001, 10001, 2], [10004, 10004, 1]],
    marker: { backend: "cloud-worker", uid: 10001, gid: 10001, profile: "zeros-cloud-worker-v4", version: 4 },
    active: { schema: "zeros.active-runtime/v1", runtimeId, root: `/opt/zeros-infra/${runtimeId}`,
      manifestSha256, baseCompatibilityId: `bc1-${createHash("sha256").update("SOURCE-MODE fixture; not a qualified base").digest("hex")}`,
      installerReceiptSha256: createHash("sha256").update("SOURCE-MODE fixture; not an installer receipt").digest("hex"),
      bootId: randomUUID(), supervisorSessionId: randomUUID(), cgroupRoot },
  };
}
/** An environment-mode run must be deliberately authorized by its operator.
 * The runner never upgrades invalid mode based on ambient credentials. */
export function fixtureCredentialEnv(mode: "invalid" | "environment", env: Record<string, string | undefined>, authorized = false): Record<string, string> {
  if (mode === "invalid") return { ANTHROPIC_API_KEY: "fixture-invalid-key", OPENAI_API_KEY: "fixture-invalid-key", CURSOR_API_KEY: "fixture-invalid-key" };
  if (!authorized) throw new HarnessFailure("owner_authorization_required");
  return Object.fromEntries(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CURSOR_API_KEY"]
    .filter(key => typeof env[key] === "string" && env[key]!.length > 0).map(key => [key, env[key]!])) as Record<string, string>;
}
