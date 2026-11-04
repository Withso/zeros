import { CodeReviewError } from "./code-review-errors";

export interface CodeReviewPathRuntime {
  path: { sep: string; resolve(...paths: string[]): string; dirname(value: string): string; relative(from: string, to: string): string; join(...paths: string[]): string };
  fs: { lstatSync(value: string): { isSymbolicLink(): boolean }; realpathSync(value: string): string; statSync(value: string): { isFile(): boolean } };
  isSensitiveRepoPath(value: string): boolean;
}

export interface CodeReviewPathPolicy {
  remote?: boolean;
  ownerRoots?: () => readonly string[];
}
const denied = () => new CodeReviewError("CODE_REVIEW_PATH_DENIED", "This review file is outside the authorized workspace.");
const unavailable = () => new CodeReviewError("CODE_REVIEW_AUTHORITY_REJECTED", "Review workspace metadata could not be verified. Retry the read.");

/** Old/deleted paths still have anchors. Resolve through the nearest existing
 * ancestor without reading source or creating a file/directory. */
function physicalPath(runtime: CodeReviewPathRuntime, target: string): string {
  const { fs, path } = runtime;
  let ancestor = target;
  for (;;) {
    let entry: { isSymbolicLink(): boolean };
    try {
      entry = fs.lstatSync(ancestor);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT" || path.dirname(ancestor) === ancestor) throw unavailable();
      ancestor = path.dirname(ancestor);
      continue;
    }
    try { return path.join(fs.realpathSync(ancestor), path.relative(ancestor, target)); }
    catch { throw entry.isSymbolicLink() ? denied() : unavailable(); }
  }
}

function assertReviewName(runtime: CodeReviewPathRuntime, relative: string, policy: CodeReviewPathPolicy): void {
  if (relative.split("/").some((part) => [".git", ".zeros", ".appdata", ".conductor"].includes(part.toLowerCase()))) throw denied();
  if (policy.remote && runtime.isSensitiveRepoPath(relative)) throw denied();
}

export function assertCodeReviewPathCore(runtime: CodeReviewPathRuntime, root: string, relative: string, policy: CodeReviewPathPolicy = {}, creating = false): void {
  const { fs, path } = runtime;
  const isInside = (target: string, root: string) => target === root || target.startsWith(root + path.sep);
  assertReviewName(runtime, relative, policy);
  const lexicalRoot = path.resolve(root);
  const target = path.resolve(root, relative);
  const realRoot = physicalPath(runtime, lexicalRoot);
  const realTarget = physicalPath(runtime, target);
  if (!isInside(target, lexicalRoot) || !isInside(realTarget, realRoot)) throw denied();
  assertReviewName(runtime, path.relative(realRoot, realTarget).split(path.sep).join("/"), policy);
  // The original path remains the durable privacy/owner boundary even after a
  // file is deleted. Do not create or expose anchors through a file/directory
  // alias whose original target could disappear or be redirected later.
  if (realTarget !== path.resolve(realRoot, relative)) throw denied();
  let owners: readonly string[];
  try { owners = policy.ownerRoots?.() ?? []; } catch { throw unavailable(); }
  for (const owner of owners) {
    const lexicalOwner = path.resolve(owner);
    const physicalOwner = physicalPath(runtime, lexicalOwner);
    if (lexicalOwner === lexicalRoot || physicalOwner === realRoot) continue;
    if ((isInside(lexicalOwner, lexicalRoot) && isInside(target, lexicalOwner)) ||
        (isInside(physicalOwner, realRoot) && isInside(realTarget, physicalOwner))) throw denied();
  }
  if (creating) {
    try {
      if (!fs.statSync(target).isFile()) throw denied();
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") throw denied();
    }
  }
}
