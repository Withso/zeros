import fs from "node:fs";
import path from "node:path";
import type { QualifiedCloudFilePolicy } from "../files/cloud-file-policy";
import { isInside, isSensitiveRepoPath } from "../files/read-file";
import { CodeReviewError } from "./errors";

export interface CodeReviewPathPolicy {
  remote?: boolean;
  cloudFiles?: QualifiedCloudFilePolicy;
  ownerRoots?: () => readonly string[];
}
const denied = () => new CodeReviewError("CODE_REVIEW_PATH_DENIED", "This review file is outside the authorized workspace.");
const unavailable = () => new CodeReviewError("CODE_REVIEW_AUTHORITY_REJECTED", "Review workspace metadata could not be verified. Retry the read.");

/** Old/deleted paths still have anchors. Resolve through the nearest existing
 * ancestor without reading source or creating a file/directory. */
function physicalPath(target: string): string {
  let ancestor = target;
  for (;;) {
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(ancestor) === ancestor) throw unavailable();
      ancestor = path.dirname(ancestor);
      continue;
    }
    try { return path.join(fs.realpathSync(ancestor), path.relative(ancestor, target)); }
    catch { throw entry.isSymbolicLink() ? denied() : unavailable(); }
  }
}

function assertReviewName(relative: string, policy: CodeReviewPathPolicy): void {
  if (relative.split("/").some((part) => [".git", ".zeros", ".appdata", ".conductor"].includes(part.toLowerCase()))) throw denied();
  if (policy.remote && !policy.cloudFiles && isSensitiveRepoPath(relative)) throw denied();
  if (policy.cloudFiles) {
    try { policy.cloudFiles.assertPath(relative); } catch { throw denied(); }
  }
}

export function assertCodeReviewPath(root: string, relative: string, policy: CodeReviewPathPolicy = {}, creating = false): void {
  assertReviewName(relative, policy);
  const lexicalRoot = path.resolve(root);
  const target = path.resolve(root, relative);
  const realRoot = physicalPath(lexicalRoot);
  const realTarget = physicalPath(target);
  if (!isInside(target, lexicalRoot) || !isInside(realTarget, realRoot)) throw denied();
  assertReviewName(path.relative(realRoot, realTarget).split(path.sep).join("/"), policy);
  // The original path remains the durable privacy/owner boundary even after a
  // file is deleted. Do not create or expose anchors through a file/directory
  // alias whose original target could disappear or be redirected later.
  if (realTarget !== path.resolve(realRoot, relative)) throw denied();
  let owners: readonly string[];
  try { owners = policy.ownerRoots?.() ?? []; } catch { throw unavailable(); }
  for (const owner of owners) {
    const lexicalOwner = path.resolve(owner);
    const physicalOwner = physicalPath(lexicalOwner);
    if (lexicalOwner === lexicalRoot || physicalOwner === realRoot) continue;
    if ((isInside(lexicalOwner, lexicalRoot) && isInside(target, lexicalOwner)) ||
        (isInside(physicalOwner, realRoot) && isInside(realTarget, physicalOwner))) throw denied();
  }
  if (creating) {
    try {
      if (!fs.statSync(target).isFile()) throw denied();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw denied();
    }
  }
}
