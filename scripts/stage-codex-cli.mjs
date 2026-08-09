#!/usr/bin/env node
// Stage the complete pinned Codex native runtime for electron-builder.
//
// The packaged engine is a Bun single-file binary and has no node_modules to
// resolve @openai/codex's optional platform package from. Shipping only the
// main executable is also insufficient: Codex locates its code-mode host,
// ripgrep, and resources relative to the vendor target directory. Preserve that
// directory shape at a stable, version-free path in Contents/Resources.

import { createRequire } from "node:module";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");
const require = createRequire(join(repoRoot, "package.json"));

export const STAGED_RUNTIME_DIR = "binaries/codex-runtime";
export const STAGED_VERSION_FILE = "binaries/codex-cli-version.txt";

const TARGETS = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    package: "@openai/codex-darwin-arm64",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    package: "@openai/codex-darwin-x64",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-musl",
    package: "@openai/codex-linux-arm64",
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-musl",
    package: "@openai/codex-linux-x64",
  },
  "win32-arm64": {
    triple: "aarch64-pc-windows-msvc",
    package: "@openai/codex-win32-arm64",
  },
  "win32-x64": {
    triple: "x86_64-pc-windows-msvc",
    package: "@openai/codex-win32-x64",
  },
};

function targetFor(platform = process.platform, arch = process.arch) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) {
    throw new Error(
      `[stage-codex-cli] unsupported platform ${platform}-${arch}`,
    );
  }
  return target;
}

export function resolveCodexRuntimeSource() {
  const wrapperPackageJson = require.resolve("@openai/codex/package.json");
  const wrapper = JSON.parse(readFileSync(wrapperPackageJson, "utf8"));
  const target = targetFor();
  const fromWrapper = createRequire(wrapperPackageJson);
  let platformPackageJson;
  try {
    platformPackageJson = fromWrapper.resolve(`${target.package}/package.json`);
  } catch {
    throw new Error(
      `[stage-codex-cli] ${target.package} is missing. It is an optional ` +
        `dependency of @openai/codex; reinstall with optional dependencies.`,
    );
  }
  const sourceRoot = join(
    dirname(platformPackageJson),
    "vendor",
    target.triple,
  );
  const runtimeManifest = join(sourceRoot, "codex-package.json");
  const executable = join(
    sourceRoot,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (!existsSync(runtimeManifest) || !existsSync(executable)) {
    throw new Error(
      `[stage-codex-cli] corrupt ${target.package}: expected ${runtimeManifest} ` +
        `and ${executable}`,
    );
  }
  const manifest = JSON.parse(readFileSync(runtimeManifest, "utf8"));
  if (
    manifest.target !== target.triple ||
    manifest.version !== wrapper.version
  ) {
    throw new Error(
      `[stage-codex-cli] runtime mismatch: wrapper=${wrapper.version}, ` +
        `runtime=${manifest.version}, target=${manifest.target}; expected ${target.triple}`,
    );
  }
  return {
    sourceRoot,
    executable,
    version: wrapper.version,
    package: target.package,
    triple: target.triple,
  };
}

function stageTree(sourceRoot, destinationRoot) {
  let files = 0;
  let bytes = 0;
  let hardlinks = 0;
  let copies = 0;
  const visit = (source, destination) => {
    const lexical = lstatSync(source);
    const actual = lexical.isSymbolicLink() ? realpathSync(source) : source;
    const stat = statSync(actual);
    if (stat.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      for (const entry of readdirSync(actual)) {
        visit(join(actual, entry), join(destination, entry));
      }
      return;
    }
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(
        `[stage-codex-cli] refusing non-file/empty runtime entry ${source}`,
      );
    }
    mkdirSync(dirname(destination), { recursive: true });
    try {
      linkSync(actual, destination);
      hardlinks += 1;
    } catch {
      copyFileSync(actual, destination);
      copies += 1;
    }
    chmodSync(destination, stat.mode & 0o777);
    files += 1;
    bytes += stat.size;
  };
  visit(sourceRoot, destinationRoot);
  return { files, bytes, hardlinks, copies };
}

export function stageCodexCli({ quiet = false } = {}) {
  const source = resolveCodexRuntimeSource();
  const destination = join(repoRoot, STAGED_RUNTIME_DIR);
  rmSync(destination, { recursive: true, force: true });
  const staged = stageTree(source.sourceRoot, destination);
  const stagedExecutable = join(
    destination,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  chmodSync(stagedExecutable, 0o755);

  const versionDestination = join(repoRoot, STAGED_VERSION_FILE);
  mkdirSync(dirname(versionDestination), { recursive: true });
  writeFileSync(versionDestination, `${source.version}\n`, "utf8");

  if (!quiet) {
    console.log(
      `[stage-codex-cli] ${source.package} ${source.version} → ` +
        `${STAGED_RUNTIME_DIR} (${staged.files} files, ` +
        `${(staged.bytes / 1024 / 1024).toFixed(1)} MiB, ` +
        `${staged.hardlinks} hardlinks, ${staged.copies} copies)`,
    );
  }
  return {
    destination,
    stagedExecutable,
    versionDestination,
    version: source.version,
    ...staged,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  try {
    stageCodexCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
