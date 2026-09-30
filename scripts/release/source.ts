import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { workerSourcePath } from "../dev-environment/source.mjs";
import { command, type Command } from "./io";
import { SHA, requireCheck, type Channel } from "./contracts";

export function classifyChanges(files: string[]) {
  return { migrations: files.some(file => /^apps\/control-plane\/migrations\/\d{4}_[a-z0-9_]+\.sql$/.test(file)),
    worker: files.some(file => workerSourcePath(file)) };
}
export async function changedFiles(sourceSha: string, baseSha: string | undefined) {
  requireCheck(SHA.test(sourceSha), "Invalid source SHA");
  const args = baseSha && !/^0+$/.test(baseSha)
    ? ["diff", "--name-only", "-z", "--no-renames", baseSha, sourceSha, "--"]
    : ["ls-tree", "-rz", "--name-only", sourceSha];
  requireCheck(!baseSha || SHA.test(baseSha), "Invalid comparison SHA");
  return (await command("git", args)).split("\0").filter(Boolean);
}
export async function assertCheckout(sourceSha: string) {
  requireCheck((await command("git", ["rev-parse", "HEAD"])).trim() === sourceSha, "Checkout differs from the event SHA");
  requireCheck(!(await command("git", ["status", "--porcelain", "--untracked-files=normal"])).trim(), "Release checkout must be clean");
}
export async function workerInputsSha256(sourceSha: string) {
  const entries = (await command("git", ["ls-tree", "-rz", sourceSha])).split("\0").filter(Boolean)
    .filter(row => workerSourcePath(row.slice(row.indexOf("\t") + 1))).sort();
  requireCheck(entries.length > 0, "Worker input manifest is empty");
  return createHash("sha256").update(entries.join("\0")).digest("hex");
}
export async function channelBaseline(channel: Channel, run: Command = command,
  published?: () => Promise<{ sourceSha: string; runId: string } | null>): Promise<{ tag: string; sourceSha: string; evidence?: string } | null> {
  const tags = (await run("git", ["for-each-ref", "--format=%(refname:strip=2)", "refs/tags"])).trim().split("\n");
  const tag = channel === "production" ? tags.filter(tag => /^v\d+\.\d+\.\d+$/.test(tag)).sort((a, b) => {
    const left = a.slice(1).split(".").map(BigInt), right = b.slice(1).split(".").map(BigInt);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1;
    return 0;
  })[0] : tags.find(tag => tag === channel);
  if (!tag) return null;
  const sourceSha = (await run("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`])).trim();
  requireCheck(SHA.test(sourceSha), "Published channel tag does not resolve to a commit");
  // The disabled guard supplies workflow proof. Tag-only reads remain useful
  // for inspection, but cannot bootstrap an existing legacy rolling release.
  if (published) {
    const release = await published();
    if (!release) return null;
    requireCheck(SHA.test(release.sourceSha) && /^[1-9]\d*$/.test(release.runId), "Published workflow identity is invalid");
    return { tag, sourceSha: release.sourceSha, evidence: `Successful ${channel} publication run ${release.runId} at ${release.sourceSha}; ` +
      (sourceSha === release.sourceSha ? `${tag} tag agrees.` : `tag discrepancy: ${tag} points to ${sourceSha}; using verified successful publication, without moving any tag.`) };
  }
  return { tag, sourceSha };
}

export async function migrationManifest(sourceSha?: string, run: Command = command) {
  const directory = "apps/control-plane/migrations";
  if (sourceSha !== undefined) {
    requireCheck(SHA.test(sourceSha), "Invalid migration manifest source");
    const entries = (await run("git", ["ls-tree", "-rz", "--full-tree", sourceSha, "--", directory])).split("\0")
      .map(row => /^(?:100644|100755) blob ([a-f0-9]{40})\tapps\/control-plane\/migrations\/(\d{4}_[a-z0-9_]+\.sql)$/.exec(row)).filter(row => row !== null)
      .sort((a, b) => a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
    requireCheck(entries.length > 0, "Committed migration manifest is empty or unavailable");
    const rows: { name: string; checksum: string }[] = [];
    // Bound subprocess fanout on both CI and operator machines.
    for (let i = 0; i < entries.length; i += 8) rows.push(...await Promise.all(entries.slice(i, i + 8).map(async row => ({
      name: row[2], checksum: `sha256:${createHash("sha256").update(await run("git", ["cat-file", "blob", row[1]])).digest("hex")}`,
    }))));
    return { head: rows.at(-1)!.name, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
  }
  const names = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  requireCheck(names.length > 0, "Migration manifest is empty");
  const rows = await Promise.all(names.map(async name => ({ name, checksum: `sha256:${createHash("sha256").update(await readFile(`${directory}/${name}`)).digest("hex")}` })));
  return { head: names.at(-1)!, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
}
