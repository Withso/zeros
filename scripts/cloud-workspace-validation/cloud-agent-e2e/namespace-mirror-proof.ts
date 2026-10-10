import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync, statfsSync } from "node:fs";
import Database from "better-sqlite3";
import { z } from "zod";
import { CloudAgentBootScopeSchema, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { HarnessFailure } from "./assertions";
import { assertInstalledHarnessRuntimeCurrent, assertPrivateNamespace, assertPrivateRoot, requireInstalledHarnessBinding,
  type InstalledHarnessHandover } from "./runtime-contract";
import { observedInstalledRootIdentity, requireInstalledRootIdentity, type InstalledRootIdentity } from "./identity";
import type { CloudActiveRuntime } from "../../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { assertPrivatePidNamespace } from "./fixture-scope";
import { readFixtureLocalMirrorProof } from "./local-mirror-proof";

const file = `/srv/zeros/state/engines/workspace-${createHash("sha256").update("/srv/zeros/workspace").digest("hex").slice(0, 12)}/cloud-local-commands.sqlite`;
type Handle = { readonly: boolean; close(): void };
type Io = { observe(): { uid: number; mountNamespace: string; pidNamespace: string; pid: number; rootType: number; procType: number; initNamespace: string };
  realpath(filename: string): string; metadata(filename: string): { uid: number; gid: number; mode: number; nlink: number; isFile(): boolean; isSymbolicLink(): boolean };
  open(filename: string, options: { readonly: true; fileMustExist: true }): Handle };
const actualIo: Io = { observe: () => ({ uid: process.getuid!(), mountNamespace: readlinkSync("/proc/self/ns/mnt"),
  pidNamespace: readlinkSync("/proc/self/ns/pid"), pid: process.pid, rootType: statfsSync("/").type,
  procType: statfsSync("/proc").type, initNamespace: readlinkSync("/proc/1/ns/pid") }),
  realpath: realpathSync, metadata: lstatSync, open: (filename, options) => new Database(filename, options) };

/** Fixed fixture path only, after real private mount/PID/root/proc proof. No
 * caller can choose a host path and SQLite receives read-only flags. */
export function readPrivateFixtureMirrorProof(input: { outerMountNamespace: string; outerPidNamespace: string;
  scope: CloudAgentBootScope; commandId: string; conversationId: string }, io: Io = actualIo) {
  let db: Handle | undefined;
  let proof: ReturnType<typeof readFixtureLocalMirrorProof> | undefined;
  let failed = false;
  try {
    const view = io.observe();
    assertPrivateNamespace({ outer: input.outerMountNamespace, current: view.mountNamespace, uid: view.uid });
    assertPrivatePidNamespace(input.outerPidNamespace, view.pidNamespace, view.pid);
    assertPrivateRoot(view.rootType);
    if (view.procType !== 0x9fa0 || view.initNamespace !== view.pidNamespace) throw new Error();
    const scope = CloudAgentBootScopeSchema.parse(input.scope);
    z.uuid().parse(input.commandId); z.uuid().parse(input.conversationId);
    const metadata = io.metadata(file);
    if (io.realpath(file) !== file || metadata.isSymbolicLink() || !metadata.isFile() || metadata.uid !== 10003 || metadata.gid !== 10003 ||
        metadata.nlink !== 1 || metadata.mode & 0o022) throw new Error();
    db = io.open(file, { readonly: true, fileMustExist: true });
    if (!db.readonly) throw new Error();
    proof = readFixtureLocalMirrorProof(db as Database.Database, { scope, commandId: input.commandId, conversationId: input.conversationId });
  } catch { failed = true; }
  try { db?.close(); } catch { failed = true; }
  if (failed || !proof) throw new HarnessFailure("fixture_inspection_failed");
  return proof;
}

type InstalledMirrorInput = { active: CloudActiveRuntime; originalRoot: InstalledRootIdentity;
  handover: InstalledHarnessHandover; activeRecordSha256: string;
  scope: CloudAgentBootScope; commandId: string; conversationId: string };
type InstalledMirrorMetadata = ReturnType<Io["metadata"]> & { dev: string; ino: string };
type InstalledMirrorIO = Pick<Io, "realpath" | "open"> & {
  metadata(filename: string): InstalledMirrorMetadata;
  assertOriginal(input: InstalledMirrorInput): void;
};
const installedIo: InstalledMirrorIO = { realpath: realpathSync, open: actualIo.open,
  metadata: filename => {
    const stat = lstatSync(filename, { bigint: true });
    return { uid: Number(stat.uid), gid: Number(stat.gid), mode: Number(stat.mode), nlink: Number(stat.nlink),
      dev: String(stat.dev), ino: String(stat.ino), isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() };
  },
  assertOriginal: input => {
    assertInstalledHarnessRuntimeCurrent(input.handover, input.activeRecordSha256);
    observedInstalledRootIdentity(input.active, input.originalRoot);
  },
};

/** Installed evidence uses the real VM's original root and installation pins,
 * never the SOURCE private-PID exemption. SQLite remains read-only, with a
 * fixed canonical engine file and original inode checks around the SQL proof.
 * Optional IO is a portable test seam, not a wire or operator input. */
export function readInstalledFixtureMirrorProof(input: InstalledMirrorInput, io: InstalledMirrorIO = installedIo) {
  let db: Handle | undefined, proof: ReturnType<typeof readFixtureLocalMirrorProof> | undefined;
  let failed = false;
  try {
    requireInstalledHarnessBinding(input.handover, input.active, input.originalRoot.executable);
    requireInstalledRootIdentity(input.originalRoot, input.active);
    if (!/^[a-f0-9]{64}$/.test(input.activeRecordSha256)) throw new Error();
    io.assertOriginal(input);
    const scope = CloudAgentBootScopeSchema.parse(input.scope);
    z.uuid().parse(input.commandId); z.uuid().parse(input.conversationId);
    const valid = (stat: InstalledMirrorMetadata) => stat.isFile() && !stat.isSymbolicLink() &&
      stat.uid === 10003 && stat.gid === 10003 && stat.nlink === 1 && !(stat.mode & 0o7022) &&
      /^(0|[1-9][0-9]{0,19})$/.test(stat.dev) && /^[1-9][0-9]{0,19}$/.test(stat.ino) &&
      BigInt(stat.dev) <= (1n << 64n) - 1n && BigInt(stat.ino) <= (1n << 64n) - 1n;
    const before = io.metadata(file);
    if (!valid(before) || io.realpath(file) !== file) throw new Error();
    db = io.open(file, { readonly: true, fileMustExist: true });
    if (!db.readonly) throw new Error();
    proof = readFixtureLocalMirrorProof(db as Database.Database, { scope, commandId: input.commandId, conversationId: input.conversationId });
    const after = io.metadata(file);
    if (!valid(after) || before.dev !== after.dev || before.ino !== after.ino || io.realpath(file) !== file) throw new Error();
  } catch { failed = true; }
  try { db?.close(); } catch { failed = true; }
  try { if (!failed) io.assertOriginal(input); } catch { failed = true; }
  if (failed || !proof) throw new HarnessFailure("fixture_inspection_failed");
  return proof;
}
