import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIMITS, PROVIDERS, managedPath } from "./config.mjs";
import { invariant, parseJson, validateTask } from "./contracts.mjs";
import {
  validateLockChange,
  validateManifestChange,
  validatePatch,
} from "./patch.mjs";
import { inspectSurfaces } from "./surfaces.mjs";
import { cleanProcessEnv } from "./environment.mjs";
import { readBoundedRegularFile } from "./files.mjs";
export { cleanProcessEnv } from "./environment.mjs";

export function git(root, args, maximum = LIMITS.patch) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: maximum,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function gitTree(root, ref) {
  return git(root, ["ls-tree", "-rz", ref])
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, sha] = entry.slice(0, tab).split(" ");
      return { path: entry.slice(tab + 1), mode, type, sha };
    });
}

export function executePreparation(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: cleanProcessEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10 * 60_000,
    maxBuffer: LIMITS.patch,
  });
  // Commands are fixed here; exception/output strings can contain arbitrary
  // upstream text and do not belong in the public JSON report.
  invariant(
    !result.error && result.status === 0,
    `Mechanical preparation command failed: ${command} ${args[0]} (exit ${result.status ?? "unavailable"}).`,
  );
  return { exitCode: result.status };
}

export function checkManualEdits(root, task) {
  if (!task.lastBotCommit || task.lastBotCommit === task.head) return;
  invariant(
    git(root, [
      "merge-base",
      "--is-ancestor",
      task.lastBotCommit,
      task.head,
    ]) === "",
    "The bot baseline is not an ancestor of the working head.",
  );
  const changed = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "--no-renames",
    "-z",
    task.lastBotCommit,
    task.head,
    "--",
  ])
    .split("\0")
    .filter(Boolean);
  for (const file of changed.filter((path) =>
    managedPath(task.provider, path),
  )) {
    if (file === "package.json") {
      const old = parseJson(
        git(root, ["show", `${task.lastBotCommit}:package.json`]),
      );
      const current = parseJson(readFileSync(join(root, file), "utf8"));
      const name = PROVIDERS[task.provider].package;
      invariant(
        old.dependencies?.[name] === current.dependencies?.[name] &&
          (task.provider !== "codex" ||
            old.codexProtocolVersion === current.codexProtocolVersion),
        "A maintainer changed the selected runtime pin; review it before regeneration.",
      );
    } else {
      throw new Error(
        "A maintainer changed managed generated/lock/license files. Resolve on this PR or explicitly request agent-runtime:regenerate after reviewing the intended regeneration.",
      );
    }
  }
}

export async function prepareUpdate(
  task,
  { root, execute = executePreparation, inspect = inspectSurfaces } = {},
) {
  validateTask(task);
  root = realpathSync(resolve(root));
  invariant(
    git(root, ["rev-parse", "HEAD"]).trim() === task.head,
    "Preparation checkout is not the expected PR head.",
  );
  invariant(
    git(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z"]) ===
      "",
    "Preparation requires a clean working tree; no user work was changed.",
  );
  checkManualEdits(root, task);
  const tree = gitTree(root, task.head);
  const before = readFileSync(join(root, "package.json"), "utf8");
  const beforeLock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const manifest = parseJson(before);
  invariant(
    manifest.dependencies?.[PROVIDERS[task.provider].package] === task.from,
    "Working runtime pin changed before preparation.",
  );
  manifest.dependencies[PROVIDERS[task.provider].package] = task.version;
  if (task.provider === "codex") manifest.codexProtocolVersion = task.version;
  const after = `${JSON.stringify(manifest, null, 2)}\n`;
  validateManifestChange(before, after, task);
  writeFileSync(join(root, "package.json"), after);
  const run = (command, args) => execute(command, args, root);
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"]);
  validateLockChange(
    beforeLock,
    readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
    task,
  );
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]);
  if (task.provider === "codex")
    run(process.execPath, ["scripts/codegen-codex.mjs", "--force"]);
  run(process.execPath, ["scripts/prepare-third-party-license-graphs.mjs"]);
  run(process.execPath, ["scripts/generate-third-party-licenses.mjs"]);
  const changed = new Set([
    ...git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "--no-renames",
      "-z",
      "HEAD",
      "--",
    ])
      .split("\0")
      .filter(Boolean),
    ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean),
  ]);
  invariant(
    changed.size <= LIMITS.files,
    "Preparation changed too many files.",
  );
  const deleted = new Set(
    git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-only",
      "--diff-filter=D",
      "--no-renames",
      "-z",
      "HEAD",
      "--",
    ])
      .split("\0")
      .filter(Boolean),
  );
  const oldFiles = new Map(tree.map((entry) => [entry.path, entry]));
  const files = [...changed].sort().map((file) => {
    invariant(
      managedPath(task.provider, file),
      "A generator changed a file outside its declared ownership.",
    );
    if (deleted.has(file))
      return {
        path: file,
        beforeBlob: oldFiles.get(file)?.sha ?? null,
        after: null,
      };
    const bytes = readBoundedRegularFile(root, file, { allowExecutable: false });
    const text = bytes.toString("utf8");
    invariant(
      Buffer.from(text, "utf8").equals(bytes),
      "Generated output is not valid UTF-8.",
    );
    return {
      path: file,
      beforeBlob: oldFiles.get(file)?.sha ?? null,
      after: text,
    };
  });
  const patch = {
    schema: 1,
    taskId: task.id,
    head: task.head,
    provider: task.provider,
    version: task.version,
    files,
  };
  validatePatch(patch, task, tree);
  // Generation and --check can agree on the wrong workspace's native runtime.
  // Require the candidate's release identity in the exact bytes being proposed.
  const licenses =
    files.find((file) => file.path === "THIRD-PARTY-LICENSES.txt")?.after ??
    readBoundedRegularFile(root, "THIRD-PARTY-LICENSES.txt").toString("utf8");
  const name = PROVIDERS[task.provider].package;
  const releasePackage = task.provider === "codex"
    ? `${name}@${task.version}-darwin-arm64`
    : `${name}-darwin-arm64@${task.version}`;
  invariant(
    licenses.split("\n").includes(releasePackage),
    "Prepared bundle is missing the candidate's macOS release license inventory.",
  );
  let changes = [];
  let surfaceStatus = "passed";
  try {
    changes = await inspect({ root, base: task.main });
    if (changes.some((change) => !change.disposition)) surfaceStatus = "failed";
  } catch {
    surfaceStatus = "incomplete";
  }
  return {
    status: files.length === 0 ? "unchanged" : "prepared",
    taskId: task.id,
    provider: task.provider,
    patch,
    report: {
      schema: 1,
      head: task.head,
      testedHead: null,
      provider: task.provider,
      candidate: task.version,
      changes,
      gates: [
        { name: "mechanical-preparation", status: "passed", exitCode: 0 },
        {
          name: "surface-review",
          status: surfaceStatus,
          exitCode: surfaceStatus === "passed" ? 0 : 1,
        },
      ],
      summary:
        files.length === 0
          ? "Regeneration verified the recorded input head without file changes. An App acknowledgment commit records the baseline; full qualification must run on that commit."
          : "Prepared mechanical changes against the recorded input head. Full qualification must run after the actual commit is pushed; pending integration review is not a pass.",
    },
  };
}
