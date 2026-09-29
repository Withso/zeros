import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { isSensitiveRepoPath } from "./read-file";
import { publishCloudWorkspacePath } from "./cloud-workspace-ownership";

// These names represent engine/provider storage, not repository credentials.
// A tenant's .env or PEM file is ordinary checkout content for an editor.
const privateSegments = new Set([".git", ".zeros", ".appdata", ".conductor", ".ssh", ".aws", ".gnupg", ".gpg", ".kube"]);
const privateNames = new Set(["zeros-dev-env.json", ".zeros-canvas.json"]);
const inside = (target: string, root: string) => target === root || target.startsWith(root + path.sep);
class CloudFileAccessDenied extends Error {
  constructor() { super("Cloud file access is outside the admitted repository policy"); }
}
const denied = () => new CloudFileAccessDenied();
const policyScope = new AsyncLocalStorage<QualifiedCloudFilePolicy>();

/** Set only by WorkspaceService after immutable deployment, primary-checkout
 * and live actor admission. It is never reconstructed from request parameters.
 * Async scope carries the same guard through context migration/share helpers. */
export const currentCloudFilePolicy = () => policyScope.getStore();
export function withCloudFilePolicy<T>(policy: QualifiedCloudFilePolicy, body: () => T): T {
  return policyScope.run(policy, body);
}

export class QualifiedCloudFilePolicy {
  readonly root: string;
  constructor(root: string, private readonly options: {
    canEdit: boolean;
    authorized: () => boolean;
    privateRoots: readonly string[];
    ownerRoots: () => readonly string[];
  }) {
    this.root = fs.realpathSync(root);
  }

  assertAuthorized(write = false): void {
    if (!this.options.authorized() || (write && !this.options.canEdit)) throw denied();
  }

  private check(target: string, contextMigration: boolean): void {
    if (!inside(target, this.root)) throw denied();
    const relative = path.relative(this.root, target);
    const segments = relative.split(path.sep);
    const managedMigration = contextMigration && /^\.context\/local\/\.zeros-context-migration(?:\/|$)/.test(relative);
    if (segments.some((segment, index) => privateSegments.has(segment.toLowerCase()) ||
          (segment.toLowerCase().startsWith(".zeros-") && !(managedMigration && index === 2))) ||
        privateNames.has(path.basename(target).toLowerCase()) ||
        /(?:^|\/)(?:\.codex\/auth\.json|\.claude\/\.credentials\.json|\.cursor\/(?:auth|credentials)\.json)$/i.test(relative) ||
        (!this.options.canEdit && isSensitiveRepoPath(relative))) throw denied();
    for (const root of this.options.privateRoots) {
      const lexical = path.resolve(root);
      let real = lexical;
      try { real = fs.realpathSync(lexical); } catch { /* absent private roots remain reserved */ }
      if (inside(target, lexical) || inside(target, real)) throw denied();
    }
    for (const root of this.options.ownerRoots()) {
      const lexical = path.resolve(root);
      let real = lexical;
      try { real = fs.realpathSync(lexical); } catch { /* a missing owner still reserves its path */ }
      if ((lexical !== this.root && inside(target, lexical)) || (real !== this.root && inside(target, real))) throw denied();
    }
    // A newly-created nested checkout need not have reached the owner's DB yet.
    // Treat its .git file (linked worktree/submodule) and directory identically.
    let current = this.root;
    for (const segment of segments) {
      if (!segment) continue;
      current = path.join(current, segment);
      try {
        fs.lstatSync(path.join(current, ".git"));
        throw denied();
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  }

  /** Resolve even a new file through its nearest existing ancestor. Check both
   * the lexical name and target, including registered nested owners. */
  assertPath(relative: string, write = false, contextMigration = false): string {
    this.assertAuthorized(write);
    if (typeof relative !== "string" || relative.includes("\0") || relative.includes("\\") || path.isAbsolute(relative) ||
        relative.split("/").includes("..") || fs.realpathSync(this.root) !== this.root) throw denied();
    const target = path.resolve(this.root, relative);
    this.check(target, contextMigration);
    let ancestor = target;
    let stat: fs.Stats;
    for (;;) {
      try { stat = fs.lstatSync(ancestor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === this.root) throw denied();
        ancestor = path.dirname(ancestor);
      }
    }
    const real = path.join(fs.realpathSync(ancestor), path.relative(ancestor, target));
    this.check(real, contextMigration);
    if (ancestor === target) {
      stat = fs.statSync(target);
      if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw denied();
    }
    return real;
  }

  allows(relative: string): boolean {
    try { this.assertPath(relative); return true; }
    catch (error) {
      if (error instanceof CloudFileAccessDenied ||
          ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      // Metadata failures are not proof of an empty checkout. Let the renderer
      // retain its last confirmed exact-key snapshot instead of clearing it.
      throw error;
    }
  }

  /** Cloud workers are Linux. Inspect the opened inode, not just its earlier
   * pathname, so a symlink or hardlink swap cannot return private bytes. */
  assertDescriptor(fd: number, expected: string, write = false): void {
    const actual = fs.realpathSync(`/proc/self/fd/${fd}`);
    if (actual !== expected || this.assertPath(path.relative(this.root, actual), write) !== expected) throw denied();
    const stat = fs.fstatSync(fd);
    if ((!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw denied();
  }

  /** Pin the directory through mkdir and atomic rename; never create through an
   * unchecked ancestor. Only the owned VM path opts into this Linux contract. */
  openWriteParent(relative: string, expectedTarget?: string): { fd: number; directory: string; target: string } {
    const target = this.assertPath(relative, true);
    // Async Design admission inspected this destination. A changed alias must
    // not redirect its authority, even to another path inside the checkout.
    if (expectedTarget !== undefined && target !== expectedTarget) throw denied();
    const directory = path.dirname(target);
    let fd = fs.openSync(this.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    let current = this.root;
    try {
      this.assertDescriptor(fd, current, true);
      for (const segment of path.relative(this.root, directory).split(path.sep).filter(Boolean)) {
        this.assertDescriptor(fd, current, true);
        const child = `/proc/self/fd/${fd}/${segment}`;
        try { fs.mkdirSync(child); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const next = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        fs.closeSync(fd); fd = next; current = path.join(current, segment);
        this.assertDescriptor(fd, current, true);
      }
      return { fd, directory, target };
    } catch (error) { fs.closeSync(fd); throw error; }
  }

  assertNoNestedOwners(): void {
    this.assertAuthorized(true);
    if (this.options.ownerRoots().some(root => path.resolve(root) !== this.root && inside(path.resolve(root), this.root))) throw denied();
  }

  createDirectory(relative: string): boolean {
    const directory = this.assertPath(relative, true);
    const existed = fs.existsSync(directory);
    const parent = this.openWriteParent(`${relative}/.context-directory-probe`);
    try {
      this.assertDescriptor(parent.fd, directory, true);
      publishCloudWorkspacePath(directory, parent.fd);
      return !existed;
    } finally { fs.closeSync(parent.fd); }
  }

  createFileExclusive(relative: string, contents: string): void {
    const parent = this.openWriteParent(relative);
    try {
      const fd = fs.openSync(`/proc/self/fd/${parent.fd}/${path.basename(parent.target)}`,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        this.assertDescriptor(fd, parent.target, true);
        fs.writeFileSync(fd, contents, "utf8");
        publishCloudWorkspacePath(parent.target, fd);
      } finally { fs.closeSync(fd); }
    } finally { fs.closeSync(parent.fd); }
  }

  renameDirectory(source: string, target: string): void {
    const from = this.openWriteParent(source);
    try {
      const to = this.openWriteParent(target);
      try {
        this.assertDescriptor(from.fd, from.directory, true);
        this.assertDescriptor(to.fd, to.directory, true);
        this.assertPath(source, true); this.assertPath(target, true);
        fs.renameSync(`/proc/self/fd/${from.fd}/${path.basename(from.target)}`, `/proc/self/fd/${to.fd}/${path.basename(to.target)}`);
      } finally { fs.closeSync(to.fd); }
    } finally { fs.closeSync(from.fd); }
  }
}
