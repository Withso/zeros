#!/usr/bin/env node
// Stage the complete pinned Codex native runtime for electron-builder.
//
// The packaged engine is a Bun single-file binary and cannot resolve
// @openai/codex's optional platform dependency. Preserve the wrapper's
// vendor/<triple> layout because the native runtime resolves its code-mode
// host, ripgrep, and sandbox resources relative to that managed package root.

import { spawnSync } from "node:child_process";
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
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(filename), "..");
const require = createRequire(join(repoRoot, "package.json"));

/** Stable names consumed by electron-builder.yml and packaging checks. */
export const STAGED_RUNTIME_DIR = "binaries/codex-runtime";
export const STAGED_VERSION_FILE = "binaries/codex-cli-version.txt";

export function codexTargetFor(platform, arch) {
  const targets = {
    "darwin:x64": {
      packageName: "@openai/codex-darwin-x64",
      triple: "x86_64-apple-darwin",
    },
    "darwin:arm64": {
      packageName: "@openai/codex-darwin-arm64",
      triple: "aarch64-apple-darwin",
    },
    "linux:x64": {
      packageName: "@openai/codex-linux-x64",
      triple: "x86_64-unknown-linux-musl",
    },
    "linux:arm64": {
      packageName: "@openai/codex-linux-arm64",
      triple: "aarch64-unknown-linux-musl",
    },
    "win32:x64": {
      packageName: "@openai/codex-win32-x64",
      triple: "x86_64-pc-windows-msvc",
    },
    "win32:arm64": {
      packageName: "@openai/codex-win32-arm64",
      triple: "aarch64-pc-windows-msvc",
    },
  };
  const target = targets[`${platform}:${arch}`];
  if (!target) {
    throw new Error(
      `[stage-codex-cli] unsupported Codex target ${platform}-${arch}`,
    );
  }
  return target;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `[stage-codex-cli] could not read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function collectRuntimeFiles(sourceRoot, relativeRoot) {
  const files = [];
  const visit = (source, relativePath) => {
    const lexical = lstatSync(source);
    const actual = lexical.isSymbolicLink() ? realpathSync(source) : source;
    const stat = statSync(actual);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(actual)) {
        visit(join(actual, entry), join(relativePath, entry));
      }
      return;
    }
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(
        `[stage-codex-cli] refusing non-file/empty runtime entry ${source}`,
      );
    }
    files.push({
      source: actual,
      relativePath,
      executable: (stat.mode & 0o111) !== 0,
      size: stat.size,
    });
  };
  visit(sourceRoot, relativeRoot);
  return files;
}

/** Resolve through the wrapper package so pnpm's non-hoisted optional package
 * remains visible. Every file below vendor/<triple> is staged; selecting only
 * the main binary would omit Linux sandbox assets and auxiliary executables. */
export function resolveCodexRuntimeSource({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const wrapperPackagePath = require.resolve("@openai/codex/package.json");
  const wrapperPackage = readJson(wrapperPackagePath, "@openai/codex manifest");
  if (typeof wrapperPackage.version !== "string" || !wrapperPackage.version) {
    throw new Error("[stage-codex-cli] @openai/codex has no valid version");
  }

  const { packageName, triple } = codexTargetFor(platform, arch);
  const fromWrapper = createRequire(wrapperPackagePath);
  let platformPackagePath;
  try {
    platformPackagePath = fromWrapper.resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `[stage-codex-cli] could not resolve ${packageName} from ${wrapperPackagePath}. ` +
        "Reinstall dependencies with optional packages enabled.",
      { cause: error },
    );
  }

  const platformPackage = readJson(
    platformPackagePath,
    `${packageName} manifest`,
  );
  if (
    typeof platformPackage.version !== "string" ||
    !platformPackage.version.startsWith(`${wrapperPackage.version}-`)
  ) {
    throw new Error(
      `[stage-codex-cli] platform runtime ${JSON.stringify(platformPackage.version)} ` +
        `does not match @openai/codex ${wrapperPackage.version}`,
    );
  }

  const targetRoot = join(dirname(platformPackagePath), "vendor", triple);
  const runtimeManifest = readJson(
    join(targetRoot, "codex-package.json"),
    "Codex runtime manifest",
  );
  if (
    runtimeManifest.version !== wrapperPackage.version ||
    runtimeManifest.target !== triple
  ) {
    throw new Error(
      `[stage-codex-cli] runtime manifest mismatch: wrapper=${wrapperPackage.version}, ` +
        `runtime=${runtimeManifest.version}, target=${runtimeManifest.target}; expected ${triple}`,
    );
  }

  const files = [
    {
      source: wrapperPackagePath,
      relativePath: "package.json",
      executable: false,
      size: statSync(wrapperPackagePath).size,
    },
    ...collectRuntimeFiles(targetRoot, join("vendor", triple)),
  ];
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const binaryRelativePath = join("vendor", triple, "bin", executableName);
  if (!files.some((file) => file.relativePath === binaryRelativePath)) {
    throw new Error(
      `[stage-codex-cli] ${packageName} is incomplete; missing ${binaryRelativePath}`,
    );
  }
  return {
    version: wrapperPackage.version,
    packageName,
    triple,
    files,
    binaryRelativePath,
  };
}

function stageFile(source, destination, executable) {
  mkdirSync(dirname(destination), { recursive: true });
  let method = "hardlink";
  try {
    linkSync(source, destination);
  } catch {
    copyFileSync(source, destination);
    method = "copy";
  }
  if (executable) chmodSync(destination, 0o755);
  return method;
}

export function stageCodexCli({ quiet = false } = {}) {
  const source = resolveCodexRuntimeSource();
  const runtimeRoot = join(repoRoot, STAGED_RUNTIME_DIR);
  const versionPath = join(repoRoot, STAGED_VERSION_FILE);
  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(versionPath, { force: true });

  const methods = new Set();
  let totalSize = 0;
  for (const file of source.files) {
    totalSize += file.size;
    methods.add(
      stageFile(
        file.source,
        join(runtimeRoot, file.relativePath),
        file.executable,
      ),
    );
  }
  mkdirSync(dirname(versionPath), { recursive: true });
  writeFileSync(versionPath, `${source.version}\n`, "utf8");

  const binaryPath = join(runtimeRoot, source.binaryRelativePath);
  const probe = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_MANAGED_PACKAGE_ROOT: runtimeRoot,
    },
  });
  const probeOutput = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.trim();
  if (probe.status !== 0 || !probeOutput.includes(source.version)) {
    throw new Error(
      `[stage-codex-cli] staged runtime probe failed (status=${probe.status}): ${probeOutput || "no output"}`,
    );
  }

  if (!quiet) {
    console.log(
      `[stage-codex-cli] ${[...methods].join("+")} ${source.packageName} → ` +
        `${STAGED_RUNTIME_DIR} (${source.files.length} files, ` +
        `${(totalSize / 1024 / 1024).toFixed(1)} MiB, codex ${source.version})`,
    );
  }
  return {
    runtimeRoot,
    versionPath,
    binaryPath,
    version: source.version,
    triple: source.triple,
    files: source.files.length,
    size: totalSize,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(filename)) {
  try {
    stageCodexCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
