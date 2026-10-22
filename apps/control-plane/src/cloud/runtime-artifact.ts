import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { z } from "zod";

const ENTRYPOINTS = ["worker.mjs", "cursor-host.mjs", "git-askpass.mjs", "gh.mjs", "bin/gh", "bin/git-askpass"];
const NATIVE = ["@openai/codex-linux-x64", "@anthropic-ai/claude-agent-sdk-linux-x64", "@cursor/sdk-linux-x64"];
const Manifest = z.object({
  version: z.literal(1), node: z.literal("24"), platform: z.literal("linux"), arch: z.literal("x64"),
  // A provider can bundle an export-only subpackage without its own version.
  // The actual platform packages below must still have a version.
  packages: z.record(z.string(), z.object({ name: z.string(), version: z.string().optional() })),
  files: z.record(z.string(), z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() })),
});

/** Reads selected members to stdout; never extracts an operator-supplied
 * archive onto the filesystem. Mac's tar and GNU tar both support these flags. */
const member = (archive: string, name: string) => execFileSync("tar", ["-xOzf", archive, `./${name}`], {
  maxBuffer: 16 * 1024 * 1024, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
});

export async function inspectRuntimeArchive(archive: string): Promise<{ sha256: string; bytes: number; commit: string }> {
  const stat = lstatSync(archive);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Runtime archive must be a regular file");
  if (stat.size < 1 || stat.size > 1024 ** 3) throw new Error("Runtime archive exceeds the size limit");
  let manifest: z.infer<typeof Manifest>, commit: string;
  try {
    manifest = Manifest.parse(JSON.parse(member(archive, "runtime-manifest.json").toString("utf8")));
    commit = z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/) }).parse(JSON.parse(member(archive, "BUILD.json").toString("utf8"))).commit;
    if (NATIVE.some(name => !Object.values(manifest.packages).some(pkg => pkg.name === name && pkg.version))) throw new Error();
  } catch { throw new Error("Runtime archive must contain a complete Linux x64 Node 24 worker"); }
  for (const file of ENTRYPOINTS) {
    const expected = manifest.files[file];
    const content = member(archive, file);
    if (!expected || expected.bytes !== content.length || createHash("sha256").update(content).digest("hex") !== expected.sha256)
      throw new Error("Runtime entrypoint does not match its build manifest");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  return { sha256: hash.digest("hex"), bytes: stat.size, commit };
}
