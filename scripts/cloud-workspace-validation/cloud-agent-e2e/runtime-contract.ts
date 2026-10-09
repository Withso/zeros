import { createHash, randomUUID } from "node:crypto";
import * as nativeFs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import runtimeLayout from "../sandbox/runtime-layout.json" with { type: "json" };
import { HarnessFailure } from "./assertions";
import { assertPrivatePidNamespace } from "./fixture-scope";
import { FIXTURE_ENGINE_ID_MAP } from "./projection";
import { assertCloudRuntimePath, cloudActiveRuntimeDescriptor, parseCloudActiveRuntime,
  type CloudActiveRuntime, type CloudRuntimeRoot } from "../../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import type { NamespaceOutcome } from "./retirement";

const INSTALLED_SERVICE = "/sys/fs/cgroup/system.slice/zeros-host.service";
export type InstalledHarnessHandover = Readonly<{ schema: "zeros.installed-agent-e2e/v1";
  sandboxId: string; active: CloudActiveRuntime }>;
export type InstalledCgroupIdentity = Readonly<{ directory: string; dev: string; ino: string }>;
export type InstalledTreeReceipt = InstalledCgroupIdentity & Readonly<{ populated: 0; pruned: true }>;
export type InstalledRetirement = Readonly<{ launcherExit: NamespaceOutcome; receipt: InstalledTreeReceipt }>;
const exactFields = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

/** This is a pin supplied by the installation owner, not a runtime selector.
 * Actual selection still reads the original fixed active descriptor. */
export function parseInstalledHarnessHandover(value: unknown): InstalledHarnessHandover {
  try {
    if (!exactFields(value, ["schema", "sandboxId", "active"]) || value.schema !== "zeros.installed-agent-e2e/v1" ||
      typeof value.sandboxId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(value.sandboxId)) throw new Error();
    const active = parseCloudActiveRuntime(value.active);
    installedHarnessPaths(active);
    return Object.freeze({ schema: "zeros.installed-agent-e2e/v1", sandboxId: value.sandboxId, active });
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}

export function installedHarnessPaths(active: CloudActiveRuntime) {
  try {
    if (parseCloudActiveRuntime(active).cgroupRoot !== INSTALLED_SERVICE) throw new Error();
    return Object.freeze({ service: INSTALLED_SERVICE, host: `${INSTALLED_SERVICE}/host`,
      common: `${INSTALLED_SERVICE}/engine-runtime`,
      workload: `${INSTALLED_SERVICE}/engine-runtime/engine-workload-shared/workload`,
      active: "/run/zeros/active-runtime.json", resourceMaterial: "/run/zeros/cloud-resource-contract.json",
      resourceProjection: "/etc/zeros/cloud-resource-contract.json" });
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}

/** Literal entry dispatch decides the reader before any control bytes are
 * opened. It grants no root/runtime authority; those checks follow in entry. */
export function readHarnessEntryConfiguration(args: readonly string[], io = {
  installed: (file: string): unknown => JSON.parse(readRootHarnessFile(file, 128 * 1024, 0o600).toString("utf8")),
  source: (file: string): unknown => JSON.parse(nativeFs.readFileSync(file, "utf8")),
}): { mode: "installed" | "source"; config: Record<string, unknown> } {
  try {
    if (!args[0] || args.length !== 1 && !(args.length === 2 && args[1] === "--installed")) throw new Error();
    const mode = args.length === 2 ? "installed" : "source";
    const config = io[mode](args[0]);
    if (!config || typeof config !== "object" || Array.isArray(config) ||
      (mode === "installed" ? (config as { mode?: unknown }).mode !== "installed"
        : (config as { mode?: unknown }).mode !== undefined && (config as { mode?: unknown }).mode !== "source")) throw new Error();
    return { mode, config: config as Record<string, unknown> };
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}

export type InstalledHarnessOperatorInventory = Readonly<{ schema: "zeros.installed-agent-e2e-operator/v1";
  sourceCommit: string; files: readonly Readonly<{ path: "run.mjs" | "namespace-entry.mjs"; bytes: number; sha256: string }>[] }>;
export function parseInstalledHarnessOperatorInventory(value: unknown, sourceCommit: string): InstalledHarnessOperatorInventory {
  if (!exactFields(value, ["schema", "sourceCommit", "files"]) || value.schema !== "zeros.installed-agent-e2e-operator/v1" ||
    !/^[a-f0-9]{40}$/.test(sourceCommit) || value.sourceCommit !== sourceCommit || !Array.isArray(value.files) || value.files.length !== 2)
    throw new HarnessFailure("fixture_contract_invalid");
  const names = new Set(["run.mjs", "namespace-entry.mjs"]);
  const files = value.files.map((file: unknown) => {
    if (!exactFields(file, ["path", "bytes", "sha256"]) || typeof file.path !== "string" || !names.delete(file.path) ||
      !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 2 || (file.bytes as number) > 64 * 1024 * 1024 ||
      typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new HarnessFailure("fixture_contract_invalid");
    return Object.freeze({ path: file.path as "run.mjs" | "namespace-entry.mjs", bytes: file.bytes as number, sha256: file.sha256 });
  });
  return Object.freeze({ schema: "zeros.installed-agent-e2e-operator/v1", sourceCommit, files: Object.freeze(files) });
}
export function installedHarnessOperatorPaths(entry: string) {
  if (!/^\/root\/zeros-c4-qualification\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/run\.mjs$/.test(entry))
    throw new HarnessFailure("fixture_contract_invalid");
  const directory = path.dirname(entry);
  return Object.freeze({ directory, run: entry, entry: `${directory}/namespace-entry.mjs`, inventory: `${directory}/operator-inventory.json` });
}
/** W3 verifies transferred bytes before root exec. The operator repeats that
 * check and binds its native dependency link to this genuine installed worker.
 * It never copies or modifies that worker dependency closure. */
type InstalledOperatorIO = {
  read(file: string, maximum: number, mode: number): Buffer;
  metadata(file: string): { uid: number; gid: number; isSymbolicLink(): boolean };
  link(file: string): string; realpath(file: string): string; assertDirectory(file: string): void;
};
export function readInstalledHarnessOperator(entry: string, sourceCommit: string, runtime: Pick<CloudRuntimeRoot, "workerRoot">,
  io: InstalledOperatorIO = { read: readRootHarnessFile, metadata: nativeFs.lstatSync, link: nativeFs.readlinkSync,
    realpath: nativeFs.realpathSync, assertDirectory: file => assertCloudRuntimePath(file, true) }) {
  try {
    const paths = installedHarnessOperatorPaths(entry);
    const inventory = parseInstalledHarnessOperatorInventory(JSON.parse(io.read(paths.inventory, 4096, 0o444).toString("utf8")), sourceCommit);
    for (const file of inventory.files) {
      const bytes = io.read(`${paths.directory}/${file.path}`, 64 * 1024 * 1024, 0o500);
      if (bytes.byteLength !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error();
    }
    const link = `${paths.directory}/node_modules`, target = `${runtime.workerRoot}/node_modules`, metadata = io.metadata(link);
    if (!metadata.isSymbolicLink() || metadata.uid !== 0 || metadata.gid !== 0 ||
      io.link(link) !== target || io.realpath(link) !== target) throw new Error();
    io.assertDirectory(target);
    return Object.freeze({ ...paths, inventory });
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}

export function selectHarnessRuntimeMode(args: readonly string[]): { mode: "source" } | { mode: "installed"; handoverFile: string } {
  const option = (name: string, fallback: string) => {
    const indices = args.flatMap((argument, index) => argument === name ? [index] : []);
    if (indices.length > 1) throw new HarnessFailure("operator_input_invalid");
    return indices.length ? args[indices[0]! + 1] ?? "" : fallback;
  };
  const mode = option("--runtime-mode", "source"), handoverFile = option("--installed-handover", "");
  if (mode === "source" && !handoverFile && !args.includes("--installed-handover")) return { mode };
  if (mode !== "installed" || !path.isAbsolute(handoverFile) || path.resolve(handoverFile) !== handoverFile ||
    handoverFile.includes("\0") || option("--credentials", "invalid") !== "invalid" || option("--scope", "strict") !== "strict" ||
    option("--linux-view", "host") !== "host" || option("--measurement", "boot-owner") !== "boot-owner" ||
    option("--cp-request-delay-ms", "0") !== "0" || args.includes("--owner-authorized-provider-turns"))
    throw new HarnessFailure("operator_input_invalid");
  return { mode, handoverFile };
}

/** Compare all pins after genuine installation verification. Neither an argv
 * root nor a matching hash by itself grants runtime or launch authority. */
export function requireInstalledHarnessBinding(expected: InstalledHarnessHandover, actual: unknown, executable: string): CloudActiveRuntime {
  try {
    const handover = parseInstalledHarnessHandover(expected), active = parseCloudActiveRuntime(actual);
    if (Object.keys(handover.active).some(key => handover.active[key as keyof CloudActiveRuntime] !== active[key as keyof CloudActiveRuntime]) ||
      executable !== `${active.root}/bin/node`) throw new Error();
    return active;
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}

type RootHarnessFileStat = {
  uid: number | bigint; gid: number | bigint; nlink: number | bigint; mode: number | bigint;
  size: number | bigint; dev: number | bigint; ino: number | bigint;
  isFile(): boolean; isSymbolicLink(): boolean;
};
type RootHarnessFileIO = {
  openSync(file: string, flags: number): number;
  fstatSync(descriptor: number): RootHarnessFileStat;
  lstatSync(file: string): RootHarnessFileStat;
  readSync(descriptor: number, buffer: Buffer, offset: number, length: number, position: null): number;
  closeSync(descriptor: number): void;
  assertPath(file: string): void;
};
/** Private fixed-path records never combine pathname metadata with other
 * bytes. Tests may supply explicit filesystem IO; operator input cannot. */
export function readRootHarnessFile(file: string, maximum: number, mode: number | undefined,
  io: RootHarnessFileIO = { ...nativeFs, assertPath: assertCloudRuntimePath,
    fstatSync: descriptor => nativeFs.fstatSync(descriptor, { bigint: true }),
    lstatSync: filename => nativeFs.lstatSync(filename, { bigint: true }) }): Buffer {
  let descriptor: number | undefined;
  let result: Buffer | undefined, failed = false;
  try {
    if (!Number.isSafeInteger(maximum) || maximum < 2 || maximum > 64 * 1024 * 1024) throw new Error();
    io.assertPath(file);
    descriptor = io.openSync(file, nativeFs.constants.O_RDONLY | nativeFs.constants.O_NOFOLLOW | nativeFs.constants.O_NONBLOCK);
    const unsigned = (value: number | bigint) => {
      if (typeof value !== "bigint" && !Number.isSafeInteger(value)) throw new Error();
      const exact = BigInt(value);
      if (exact < 0n || exact > (1n << 64n) - 1n) throw new Error();
      return exact;
    };
    const checked = (stat: RootHarnessFileStat) => {
      const uid = unsigned(stat.uid), gid = unsigned(stat.gid), nlink = unsigned(stat.nlink),
        modeBits = unsigned(stat.mode), size = unsigned(stat.size), dev = unsigned(stat.dev), ino = unsigned(stat.ino);
      if (!stat.isFile() || stat.isSymbolicLink() || uid !== 0n || gid !== 0n || nlink !== 1n || ino === 0n ||
        (modeBits & 0o7022n) !== 0n || (mode !== undefined && (modeBits & 0o777n) !== BigInt(mode)) ||
        size < 2n || size > BigInt(maximum)) throw new Error();
      return { dev, ino, mode: modeBits, size };
    };
    const same = (left: ReturnType<typeof checked>, right: ReturnType<typeof checked>) =>
      left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size;
    const before = checked(io.fstatSync(descriptor)), current = checked(io.lstatSync(file));
    if (!same(before, current)) throw new Error();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = io.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!Number.isSafeInteger(read) || read < 0 || read > buffer.length - size) throw new Error();
      if (!read) break;
      size += read;
    }
    const after = checked(io.fstatSync(descriptor)), finalPath = checked(io.lstatSync(file));
    io.assertPath(file);
    if (!same(before, after) || !same(after, finalPath) || after.size !== BigInt(size)) throw new Error();
    result = buffer.subarray(0, size);
  } catch { failed = true; }
  finally {
    if (descriptor !== undefined) {
      try { io.closeSync(descriptor); } catch { failed = true; }
    }
  }
  if (failed || result === undefined) throw new HarnessFailure("fixture_contract_invalid");
  return result;
}

/** No build, base/runtime copy, facade rewrite, or SOURCE fallback. The actual
 * installed attester verifies the installer inventory binding, raw manifest/
 * receipt, compatibility bytes and current kernel boot before launch. Import the
 * real helper by its physical URL so its CLI guard retains import.meta.url. */
export async function readInstalledHarnessRuntime(expected: InstalledHarnessHandover): Promise<{
  runtime: CloudRuntimeRoot; active: CloudActiveRuntime; activeRecordSha256: string;
  sourceCommit: string; archiveSha256: string;
}> {
  try {
    const handover = parseInstalledHarnessHandover(expected);
    const activeBytes = readRootHarnessFile("/run/zeros/active-runtime.json", 16 * 1024, 0o600);
    const active = requireInstalledHarnessBinding(handover, JSON.parse(activeBytes.toString("utf8")), process.execPath);
    const resolverFile = `${active.root}/lib/zeros/cloud-runtime-root.mjs`;
    assertCloudRuntimePath(resolverFile);
    const resolver = await import(pathToFileURL(resolverFile).href) as {
      resolveCloudRuntime(): CloudRuntimeRoot; assertCloudRuntimePath(file: string): void;
    };
    const runtime = resolver.resolveCloudRuntime();
    requireInstalledHarnessBinding(handover, cloudActiveRuntimeDescriptor(runtime), process.execPath);
    resolver.assertCloudRuntimePath(runtime.helpers.attester);
    const attester = await import(pathToFileURL(runtime.helpers.attester).href) as { verifyCloudV4Installation(): CloudRuntimeRoot };
    requireInstalledHarnessBinding(handover, cloudActiveRuntimeDescriptor(attester.verifyCloudV4Installation()), process.execPath);
    const manifest = JSON.parse(readRootHarnessFile(`${runtime.root}/manifest.json`, 64 * 1024 * 1024, 0o444).toString("utf8"));
    const receipt = JSON.parse(readRootHarnessFile(`/srv/zeros/runtime-installs/${runtime.runtimeId}.json`, 4096, 0o600).toString("utf8"));
    const activeRecordSha256 = createHash("sha256").update(activeBytes).digest("hex");
    assertInstalledHarnessRuntimeCurrent(handover, activeRecordSha256);
    return { runtime, active, activeRecordSha256, sourceCommit: manifest.source.commit, archiveSha256: receipt.archiveSha256 };
  } catch { throw new HarnessFailure("fixture_contract_invalid"); }
}
export function assertInstalledHarnessRuntimeCurrent(expected: InstalledHarnessHandover, activeRecordSha256: string): void {
  const bytes = readRootHarnessFile("/run/zeros/active-runtime.json", 16 * 1024, 0o600);
  if (createHash("sha256").update(bytes).digest("hex") !== activeRecordSha256) throw new HarnessFailure("fixture_contract_invalid");
  requireInstalledHarnessBinding(expected, JSON.parse(bytes.toString("utf8")), process.execPath);
}

function validKernelId(value: unknown, positive = false): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed <= (1n << 64n) - 1n && (!positive || parsed > 0n);
}
export function requireInstalledCommonIdentity(value: unknown): InstalledCgroupIdentity {
  if (!exactFields(value, ["directory", "dev", "ino"]) || value.directory !== `${INSTALLED_SERVICE}/engine-runtime` ||
    !validKernelId(value.dev) || !validKernelId(value.ino, true)) throw new HarnessFailure("cleanup_unconfirmed");
  return Object.freeze({ directory: value.directory, dev: value.dev, ino: value.ino });
}
function sameCgroup(left: InstalledCgroupIdentity, right: unknown): boolean {
  return exactFields(right, ["directory", "dev", "ino"]) && left.directory === right.directory && left.dev === right.dev && left.ino === right.ino;
}
export function requireInstalledTreeReceipt(original: InstalledCgroupIdentity, value: unknown): InstalledTreeReceipt {
  const common = requireInstalledCommonIdentity(original);
  if (!exactFields(value, ["directory", "dev", "ino", "populated", "pruned"]) ||
    !sameCgroup(common, { directory: value.directory, dev: value.dev, ino: value.ino }) || value.populated !== 0 || value.pruned !== true)
    throw new HarnessFailure("cleanup_unconfirmed");
  return Object.freeze({ ...common, populated: 0, pruned: true });
}

/** Ordinary serve retires only its engine leaf. After launcher completion,
 * the original outside-root owner kills/empties/prunes the common tree before
 * waiting for retained stdio to close. The service and /host stay owned by
 * the installation owner; release requires fresh proof after that close. */
export async function retireInstalledHarnessTree(original: InstalledCgroupIdentity, completion: Promise<NamespaceOutcome>, io: {
  assertOutside(): void; identity(directory: string): unknown; exists(directory: string): boolean;
  retire(): Promise<unknown>; drain(): Promise<unknown>; assertPreserved(): void;
}): Promise<InstalledRetirement> {
  try {
    const common = requireInstalledCommonIdentity(original);
    const launcherExit = await completion;
    io.assertOutside();
    if (!io.exists(common.directory) || !sameCgroup(common, io.identity(common.directory))) throw new Error();
    const receipt = requireInstalledTreeReceipt(common, await io.retire());
    if (io.exists(common.directory)) throw new Error();
    await io.drain();
    io.assertOutside(); io.assertPreserved();
    return Object.freeze({ launcherExit: Object.freeze({ ...launcherExit }), receipt });
  } catch { throw new HarnessFailure("cleanup_unconfirmed"); }
}

export type InstalledHarnessRetirementEvidence = { common?: InstalledCgroupIdentity; retired?: InstalledRetirement; cleanupFailed?: boolean };
/** Stop, deadline and finally all own the same full close operation. A second
 * caller cannot publish evidence while the first still drains the child. */
export function createHarnessClose(action: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => closing ??= Promise.resolve().then(action);
}
/** completion is the actual operator close event, after stdio drainage. A
 * positive common receipt stays separate from its original launcher outcome;
 * a failed auth/launch can coexist with confirmed cleanup. */
export async function awaitInstalledHarnessRetirement(completion: Promise<NamespaceOutcome>,
  evidence: () => InstalledHarnessRetirementEvidence, assertCurrent: () => void) {
  try {
    const outcome = await completion, observed = evidence();
    if (!exactFields(outcome, ["code", "signal"]) || !Number.isInteger(outcome.code) || outcome.code === null ||
      outcome.code < 0 || outcome.code > 255 || outcome.signal !== null || observed.cleanupFailed || !observed.common || !observed.retired)
      throw new Error();
    const launcherExit = observed.retired.launcherExit;
    if (!exactFields(launcherExit, ["code", "signal"]) || launcherExit.signal !== null ||
      launcherExit.code !== null && (!Number.isInteger(launcherExit.code) || launcherExit.code < 0 || launcherExit.code > 255)) throw new Error();
    const receipt = requireInstalledTreeReceipt(observed.common, observed.retired.receipt);
    assertCurrent();
    return Object.freeze({ outcome: Object.freeze({ ...outcome }), launcherExit: Object.freeze({ ...launcherExit }), receipt });
  } catch { throw new HarnessFailure("cleanup_unconfirmed"); }
}

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
    // Bubblewrap --proc locks inherited child mounts; preserve the fixture's
    // guarded real proc view for engine-owned group inspection.
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
// Portable controls compare these fixture sources with the original runtime
// export. Only the real launcher projects them onto the logical HOME aliases.
export const FIXTURE_MUTABLE_LAYOUT = Object.freeze({
  agentHome: path.join(runtimeLayout.root, "home", "engine"),
  captureHome: path.join(runtimeLayout.root, "home", "engine-capture"),
  stagingParent: path.join(runtimeLayout.engineFilesRoot, ".zeros-engine-setup"),
});
/** Reproduce frozen parents only on the namespace-private fixture filesystem. */
export function fixtureBaseOwnership() {
  return [
    { target: runtimeLayout.agentHome, mode: 0o755, uid: 10001, gid: 10001 },
    { target: runtimeLayout.captureHome, mode: 0o700, uid: 10002, gid: 10002 },
    { target: path.join(runtimeLayout.engineFilesRoot, ".zeros-setup"), mode: 0o710, uid: 0, gid: 10001 },
    { target: path.dirname(runtimeLayout.log), mode: 0o750, uid: 0, gid: 10001 },
    { target: path.join(runtimeLayout.root, "managed-settings"), mode: 0o750, uid: 0, gid: 10001 },
  ];
}
/** Apply only inside the guarded private view; never to the source checkout. */
export function fixtureMutableOwnership() {
  return [
    { target: runtimeLayout.repository, mode: 0o755, uid: 10003, gid: 10003 },
    { target: FIXTURE_MUTABLE_LAYOUT.agentHome, mode: 0o755, uid: 10003, gid: 10003 },
    { target: FIXTURE_MUTABLE_LAYOUT.captureHome, mode: 0o700, uid: 10003, gid: 10003 },
    { target: runtimeLayout.data, mode: 0o700, uid: 10003, gid: 10003 },
    { target: FIXTURE_MUTABLE_LAYOUT.stagingParent, mode: 0o710, uid: 0, gid: 10003 },
  ];
}
export function fixtureDescriptor(manifestSha256: string, cgroupRoot = "/sys/fs/cgroup/zeros-agent-e2e/zeros-host.service") {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw new HarnessFailure("fixture_contract_invalid");
  const runtimeId = `r1-${manifestSha256}`;
  return {
    evidenceKind: "source_mode_fixture" as const,
    uidMap: FIXTURE_ENGINE_ID_MAP,
    // Immutable base marker; the actual runtime projects its new engine marker.
    marker: { backend: "cloud-worker", uid: 10001, gid: 10001, profile: "zeros-cloud-worker-v4", version: 4 },
    active: { schema: "zeros.active-runtime/v1" as const, runtimeId, root: `/opt/zeros-infra/${runtimeId}`,
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
