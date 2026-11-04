import fs from "node:fs";
import path from "node:path";
import { assertCodeReviewPathCore, type CodeReviewPathPolicy } from "@zeros/protocol/code-review";
import { isSensitiveRepoPath } from "../files/read-file";
export type { CodeReviewPathPolicy } from "@zeros/protocol/code-review";

export function assertCodeReviewPath(root: string, relative: string, policy: CodeReviewPathPolicy = {}, creating = false): void {
  assertCodeReviewPathCore({ fs, path, isSensitiveRepoPath }, root, relative, policy, creating);
}
