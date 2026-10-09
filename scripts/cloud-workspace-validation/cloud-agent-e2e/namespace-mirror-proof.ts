import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync, statfsSync } from "node:fs";
import Database from "better-sqlite3";
import { z } from "zod";
import { CloudAgentBootScopeSchema, type CloudAgentBootScope } from "@zeros/protocol/cloud-agent-bootstrap";
import { HarnessFailure } from "./assertions";
import { assertPrivateNamespace, assertPrivateRoot } from "./runtime-contract";
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
