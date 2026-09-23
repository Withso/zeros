import { closeSync, constants, fchownSync, fstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { loadCloudWorkerConfiguration, type CloudWorkerConfiguration } from "../agents/containment/cloud-worker-config";

// Fixed by the isolated (v2 and later) image layout, outside the engine's
// private state/home roots.
const WORKSPACE_ROOT = "/srv/zeros/workspace";
type Identity = { uid: number; gid: number };

/** Publish engine-authored checkout bytes to the tenant identity. Descriptor
 * checks prevent symlink/hardlink aliases from transferring private authority.
 * Modes are preserved; the engine retains namespace authority over the tenant. */
export class CloudWorkspaceOwnership {
  constructor(
    private readonly root: string,
    private readonly worker: Identity,
    private readonly changeOwner = fchownSync,
  ) {}

  publish(target: string, descriptor?: number): void {
    const resolved = path.resolve(target);
    if (!resolved.startsWith(this.root + path.sep)) return;
    if (realpathSync(this.root) !== this.root)
      throw new Error("Cloud checkout ownership root changed");
    let candidate = resolved;
    let provided = descriptor;
    while (candidate !== this.root) {
      const fd = provided ?? openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = fstatSync(fd);
        if (
          realpathSync(`/proc/self/fd/${fd}`) !== candidate ||
          realpathSync(candidate) !== candidate ||
          (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
        ) throw new Error("Unsafe cloud checkout publication target");
        if (info.uid === process.geteuid!())
          this.changeOwner(fd, this.worker.uid, this.worker.gid);
        else if (info.uid !== this.worker.uid)
          throw new Error("Unexpected cloud checkout file owner");
      } finally {
        if (provided === undefined) closeSync(fd);
      }
      provided = undefined;
      candidate = path.dirname(candidate);
    }
  }
}

/** Every isolated worker profile (v2 and later) runs the tenant as its own
 * identity, so engine-authored checkout files must be published to it. */
export function publishesCloudWorkspaceOwnership(
  worker: CloudWorkerConfiguration | null | undefined,
): worker is CloudWorkerConfiguration {
  return !!worker && worker.version >= 2;
}

let ownership: CloudWorkspaceOwnership | null | undefined;
export function publishCloudWorkspacePath(target: string, descriptor?: number): void {
  if (!path.resolve(target).startsWith(WORKSPACE_ROOT + path.sep)) return;
  if (ownership === undefined) {
    const worker = loadCloudWorkerConfiguration();
    ownership = publishesCloudWorkspaceOwnership(worker)
      ? new CloudWorkspaceOwnership(WORKSPACE_ROOT, worker)
      : null;
  }
  ownership?.publish(target, descriptor);
}
