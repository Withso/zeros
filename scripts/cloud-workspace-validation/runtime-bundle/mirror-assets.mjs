import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkedRuntimeAssetUrl, downloadVerifiedAsset, RuntimeAssetError, runtimeAssetFiles, runtimeAssetLockIdentity } from "./asset-files.mjs";

const repository = "github.com/Withso/zeros";
const marker = "Runtime asset mirror (not an application release).";
export function planRuntimeAssetMirror(lock) {
  const identity = runtimeAssetLockIdentity(lock), files = runtimeAssetFiles(lock);
  return { ...identity, files, mirrorMatches: lock.mirror === identity.mirror,
    notes: `${marker}\nlock-sha256: ${identity.sha256}\n\nUnmodified pinned Ubuntu assets, including retained GPL/MPL source and Debian build recipes.\nThe runtime build still verifies the signed archive/index/package chain.\n\n` +
      files.map(file => `${file.sha256} ${file.size} ${file.path}`).join("\n") + "\n" };
}

async function runGh(args) {
  try {
    await promisify(execFile)("gh", args, { env: { ...process.env, GH_PROMPT_DISABLED: "1" }, timeout: 300_000, maxBuffer: 1024 * 1024 });
  } catch { throw new RuntimeAssetError("asset_mirror_publish"); }
}
async function releaseMetadata(tag, fetcher) {
  try {
    const target = checkedRuntimeAssetUrl(`https://api.github.com/repos/Withso/zeros/releases/tags/${tag}`, "release-metadata");
    const response = await fetcher(target.href, {
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30_000), headers: { Accept: "application/vnd.github+json" },
    });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok || !response.body) throw new Error();
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length; if (length > 1024 * 1024) throw new Error(); chunks.push(Buffer.from(chunk));
    }
    const release = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!release || typeof release !== "object" || Array.isArray(release)) throw new Error();
    return release;
  } catch { throw new RuntimeAssetError("asset_mirror_release"); }
}

/** Dry-run is completely offline. Only --apply uses the operator's gh identity. */
export async function mirrorRuntimeAssets(lock, { apply = false, fetch: fetcher = globalThis.fetch, gh = runGh, log = console.log } = {}) {
  const plan = planRuntimeAssetMirror(lock);
  log(`runtime asset mirror ${apply ? "apply" : "dry-run"}: ${plan.tag}, ${plan.files.length} files`);
  log(`mirror: ${plan.mirror}`);
  for (const file of plan.files) log(`${file.sha256} ${file.size} ${file.path}`);
  if (!apply) {
    if (!plan.mirrorMatches) log("Update lock.json mirror to the value above before applying.");
    log("No network requests or writes. Use --apply to verify canonical files, verify existing mirror assets, and upload missing assets.");
    return plan;
  }
  if (!plan.mirrorMatches) throw new RuntimeAssetError("asset_mirror_lock");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "zeros-runtime-asset-mirror-"));
  try {
    // Complete verification of all canonical content before any publication.
    for (const file of plan.files) {
      const bytes = await downloadVerifiedAsset(file.url, file, { fetch: fetcher });
      await writeFile(path.join(temporary, file.sha256), bytes, { flag: "wx", mode: 0o600 });
      log(`runtime_asset canonical ${file.sha256}`);
    }
    const release = await releaseMetadata(plan.tag, fetcher);
    if (release && (release.tag_name !== plan.tag || release.prerelease !== true || release.draft !== false ||
      typeof release.body !== "string" || !release.body.startsWith(`${marker}\nlock-sha256: ${plan.sha256}\n`) || !Array.isArray(release.assets)))
      throw new RuntimeAssetError("asset_mirror_release");
    const existing = new Set((release?.assets ?? []).map(asset => asset.name)), missing = [];
    for (const file of plan.files) {
      if (!existing.has(file.sha256)) { missing.push(file); continue; }
      await downloadVerifiedAsset(`${plan.mirror}${file.sha256}`, file, { fetch: fetcher });
      log(`runtime_asset mirror_verified ${file.sha256}`);
    }
    if (!release) {
      const notes = path.join(temporary, "notes.txt"); await writeFile(notes, plan.notes, { flag: "wx", mode: 0o600 });
      await gh(["release", "create", plan.tag, "--repo", repository, "--target", "main", "--prerelease", "--latest=false",
        "--title", `Runtime asset mirror ${plan.lock12}`, "--notes-file", notes]);
    }
    if (missing.length) {
      await gh(["release", "upload", plan.tag, ...missing.map(file => path.join(temporary, file.sha256)), "--repo", repository]);
      for (const file of missing) {
        await downloadVerifiedAsset(`${plan.mirror}${file.sha256}`, file, { fetch: fetcher });
        log(`runtime_asset mirror_verified ${file.sha256}`);
      }
    }
    return plan;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") console.log("node scripts/cloud-workspace-validation/runtime-bundle/mirror-assets.mjs [--apply]\nDefault: offline dry-run. --apply publishes the verified public mirror with gh.");
    else {
      if (args.length > 1 || (args.length === 1 && args[0] !== "--apply")) throw new RuntimeAssetError("asset_mirror_arguments");
      const lock = JSON.parse(await readFile(new URL("../../../third_party/runtime-assets/lock.json", import.meta.url), "utf8"));
      await mirrorRuntimeAssets(lock, { apply: args[0] === "--apply" });
    }
  } catch (error) {
    console.error(error instanceof RuntimeAssetError ? error.check : "asset_mirror_failed"); process.exitCode = 1;
  }
}
