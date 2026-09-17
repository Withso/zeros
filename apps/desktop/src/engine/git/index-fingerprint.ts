import { createHash } from "node:crypto";
import { runGitRead } from "./git-exec";

/** Includes every staged blob, mode, and conflict stage, plus HEAD. The
 * snapshot commit path verifies the same bytes before committing. An external
 * index edit therefore cannot silently change what the user reviewed. */
export async function gitIndexFingerprint(
  cwd: string,
  env?: Record<string, string | undefined>,
  head?: string | null,
): Promise<string> {
  const [index, resolvedHead] = await Promise.all([
    runGitRead(cwd, ["ls-files", "--stage", "-z"], {
      env,
      maxBufferBytes: 16 * 1024 * 1024,
    }),
    head !== undefined
      ? Promise.resolve(head)
      : runGitRead(cwd, ["rev-parse", "--verify", "HEAD"]).then(
          ({ stdout }) => stdout.trim(),
          () => null,
        ),
  ]);
  return createHash("sha256")
    .update(resolvedHead ?? "unborn")
    .update("\0")
    .update(index.stdout)
    .digest("hex");
}
