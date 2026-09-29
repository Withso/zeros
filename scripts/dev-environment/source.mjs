import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { privateDirectory, sha256, systemEnvironment } from "./state.mjs";

const ROOTS = new Set(["apps", "packages", "scripts", "catalogs", "styles", "third_party", "patches", "types"]);
const ROOT_FILE = /^(?:package\.json|pnpm-(?:lock\.yaml|workspace\.yaml)|tsconfig[^/]*\.json|(?:tsup|vite|vitest|postcss|tailwind|eslint)[^/]*\.(?:ts|js|mjs|cjs)|index\.html|LICENSE|THIRD-PARTY[^/]*|\.gitignore)$/;
const PRIVATE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.dev\.vars(?:\.[^/]*)?|\.npmrc|\.ssh|node_modules|\.context|\.zeros|\.zeros-dev|\.git|dist|dist-engine|dist-electron)(?:\/|$)|(?:^|\/)(?:development\.json|zeros-dev-env\.json|[^/]*\.(?:pem|key|p12|pfx))$/i;

export function deployableSourcePath(file) {
  if (!file || path.posix.isAbsolute(file) || file.includes("\\") || file.split("/").some(p => p === ".." || p === ".") || PRIVATE.test(file)) return false;
  return file.includes("/") ? ROOTS.has(file.split("/")[0]) : ROOT_FILE.test(file);
}

/** Native engine, runtime/qualification scripts, shared packages, assets and
 * dependency/build contracts. Renderer and control-plane edits do not rebuild
 * a VM. New worker build inputs must be added here alongside their build step. */
export function workerSourcePath(file) {
  if (!deployableSourcePath(file)) return false;
  if (!file.includes("/")) return true;
  if (/^(?:packages|catalogs|styles|third_party|patches|types)\//.test(file)) return true;
  if (file === "apps/desktop/src/cli.ts" || file.startsWith("apps/desktop/src/engine/") || file.startsWith("apps/desktop/src/assets/")) return true;
  // The release image kit shares its sanitation/attestation scripts with the
  // organization image builder; the standalone control plane owns that module.
  if (file === "apps/control-plane/src/cloud-workspaces/computer-image-scripts.ts") return true;
  return file.startsWith("scripts/cloud-workspace-validation/") || file.startsWith("scripts/zsr-qualification/") ||
    /^scripts\/(?:build-zsr-supervisor|codegen-codex(?:-lib)?|fix-node-pty-helper)\.(?:mjs|cjs)$/.test(file);
}

/** Desktop renderer/main files are served or rebuilt on the Mac. They are not
 * inputs to the hosted API, authentication facade, or cloud worker image. All
 * other deployable inputs stay conservative, including shared build scripts. */
export function hostedSourcePath(file) {
  return deployableSourcePath(file) && !file.startsWith("apps/desktop/src/renderer/") &&
    !file.startsWith("apps/desktop/electron/");
}

function commitSnapshot(directory, env) {
  command(directory, "git", ["init", "--quiet", "--initial-branch=dev-snapshot"], env);
  // The launcher links installed dependencies after capture. A directory-only
  // node_modules/ ignore does not cover symlinks, so record this local tooling
  // exclusion without changing the captured source or its attested commit.
  fs.appendFileSync(path.join(directory, ".git/info/exclude"), "\nnode_modules\n");
  command(directory, "git", ["add", "--all", "--", "."], env);
  const commitEnv = { ...env, GIT_AUTHOR_NAME: "Zeros Dev", GIT_COMMITTER_NAME: "Zeros Dev",
    GIT_AUTHOR_EMAIL: "dev@example.invalid", GIT_COMMITTER_EMAIL: "dev@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
  command(directory, "git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Development source snapshot"], commitEnv);
  return command(directory, "git", ["rev-parse", "HEAD"], env);
}

function command(root, command, args, env, input) {
  try { return execFileSync(command, args, { cwd: root, env, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch { throw new Error(`Dev source ${command} operation failed; captured output was withheld`); }
}

function assertRegularSource(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Dev source snapshots do not follow filesystem links");
  }
  const stat = fs.statSync(current);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Invalid or oversized Dev source file");
  return stat;
}

/** Include intended tracked and untracked source without touching the user's
 * index/branch. A private clean commit lets the existing worker image kit use
 * its exact-source attestation for an uncommitted development candidate. */
export function captureDevelopmentSource(repositoryRoot, stateDirectory) {
  const root = fs.realpathSync(repositoryRoot), parent = fs.realpathSync(stateDirectory);
  if (parent === root || parent.startsWith(root + path.sep)) throw new Error("Dev source snapshots must live outside the checkout");
  const env = { ...systemEnvironment(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", COPYFILE_DISABLE: "1" };
  const raw = command(root, "git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], env);
  const files = [...new Set(raw.split("\0").filter(deployableSourcePath))].sort();
  if (!files.includes("apps/control-plane/Dockerfile") || !files.includes("package.json")) throw new Error("Dev deployment source is incomplete");
  const directory = fs.mkdtempSync(path.join(privateDirectory(parent, "sources"), "candidate-"));
  fs.chmodSync(directory, 0o700);
  const workerDirectory = fs.mkdtempSync(path.join(privateDirectory(parent, "sources"), "worker-"));
  fs.chmodSync(workerDirectory, 0o700);
  const all = createHash("sha256"), backend = createHash("sha256"), workerInputs = createHash("sha256"), hostedInputs = createHash("sha256");
  let size = 0;
  try {
    for (const file of files) {
      // A deleted tracked path is intentionally absent from this candidate.
      if (!fs.existsSync(path.join(root, file))) continue;
      const before = assertRegularSource(root, file), data = fs.readFileSync(path.join(root, file));
      const after = fs.statSync(path.join(root, file));
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Source changed while taking the Dev snapshot; retry");
      size += data.length; if (size > 256 * 1024 * 1024) throw new Error("Dev source snapshot exceeds its size budget");
      const mode = before.mode & 0o111 ? 0o755 : 0o644;
      const target = path.join(directory, file); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, data, { mode });
      if (file !== "apps/control-plane/src/development-build.ts") {
        const row = `${file}\0${mode}\0${sha256(data)}\n`; all.update(row);
        if (file.startsWith("apps/control-plane/")) backend.update(row);
        if (hostedSourcePath(file)) hostedInputs.update(row);
        if (workerSourcePath(file)) {
          workerInputs.update(row);
          const workerTarget = path.join(workerDirectory, file); fs.mkdirSync(path.dirname(workerTarget), { recursive: true, mode: 0o700 }); fs.writeFileSync(workerTarget, data, { mode });
        }
      }
    }
    const sourceSha256 = all.digest("hex"), workerInputsSha256 = workerInputs.digest("hex");
    const build = { sourceSha256, workerInputsSha256 };
    fs.writeFileSync(path.join(directory, "apps/control-plane/src/development-build.ts"),
      `export const DEVELOPMENT_BUILD: { sourceSha256: string; workerInputsSha256: string } | null = ${JSON.stringify(build)};\n`);
    const commit = commitSnapshot(directory, env), workerCommit = commitSnapshot(workerDirectory, env);
    const archive = path.join(parent, `backend-${sourceSha256}.tar.gz`);
    command(path.join(directory, "apps/control-plane"), "tar", ["--no-xattrs", "-czf", archive,
      "Dockerfile", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "src", "migrations"], env);
    fs.chmodSync(archive, 0o600);
    const bytes = fs.readFileSync(archive);
    if (bytes.length > 32 * 1024 * 1024) throw new Error("Dev backend upload exceeds its size budget");
    return { directory, commit, sourceSha256, workerInputsSha256, deploymentInputsSha256: hostedInputs.digest("hex"),
      worker: { directory: workerDirectory, commit: workerCommit },
      backend: { archive, digest: sourceSha256, archiveSha256: sha256(bytes), inputSha256: backend.digest("hex") } };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(workerDirectory, { recursive: true, force: true }); throw error; }
}
