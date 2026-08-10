#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// stage-codex-cli — stage the pinned Codex runtime for packaged builds
// ──────────────────────────────────────────────────────────
//
// The engine is a bun-compiled single-file executable. In a packaged app it
// cannot resolve @openai/codex or its platform-specific optional dependency
// from node_modules, so the normal wrapper path is unavailable and Codex falls
// through to an arbitrary global `codex` on PATH.
//
// Preserve the platform package's vendor layout under a stable resource root:
//
//   binaries/codex-runtime/vendor/<triple>/bin/codex
//   binaries/codex-runtime/vendor/<triple>/bin/codex-code-mode-host
//   binaries/codex-runtime/vendor/<triple>/codex-path/rg
//   binaries/codex-runtime/vendor/<triple>/codex-package.json
//   binaries/codex-cli-version.txt
//
// Keeping the layout intact matters: Codex locates its code-mode host and
// vendored ripgrep relative to the managed package root. The platform package
// is excluded from app.asar and this staged tree ships once via extraResources.
// Hardlinks make local staging fast and avoid another on-disk copy before
// electron-builder copies the files into the app bundle.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(filename);
const repoRoot = resolve(scriptDir, "..");
const require = createRequire(join(repoRoot, "package.json"));

/** Stable names consumed by electron-builder.yml and check-packaging-paths. */
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

/** Resolve through the wrapper package so pnpm's non-hoisted optional package
 * is visible. This is the same anchor used by @openai/codex/bin/codex.js. */
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

  const platformRoot = dirname(platformPackagePath);
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const codeModeHostName =
    platform === "win32"
      ? "codex-code-mode-host.exe"
      : "codex-code-mode-host";
  const rgName = platform === "win32" ? "rg.exe" : "rg";
  const vendorPrefix = join("vendor", triple);
  const specs = [
    {
      source: wrapperPackagePath,
      relativePath: "package.json",
      executable: false,
    },
    {
      source: join(platformRoot, vendorPrefix, "bin", executableName),
      relativePath: join(vendorPrefix, "bin", executableName),
      executable: true,
    },
    {
      source: join(platformRoot, vendorPrefix, "bin", codeModeHostName),
      relativePath: join(vendorPrefix, "bin", codeModeHostName),
      executable: true,
    },
    {
      source: join(platformRoot, vendorPrefix, "codex-path", rgName),
      relativePath: join(vendorPrefix, "codex-path", rgName),
      executable: true,
    },
    {
      source: join(platformRoot, vendorPrefix, "codex-package.json"),
      relativePath: join(vendorPrefix, "codex-package.json"),
      executable: false,
    },
  ];

  for (const spec of specs) {
    if (!existsSync(spec.source)) {
      throw new Error(
        `[stage-codex-cli] ${packageName} is incomplete; missing ${spec.source}`,
      );
    }
    const stat = statSync(spec.source);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(
        `[stage-codex-cli] runtime input is not a non-empty file: ${spec.source}`,
      );
    }
  }

  return {
    version: wrapperPackage.version,
    packageName,
    triple,
    files: specs,
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

  let totalSize = 0;
  const methods = new Set();
  for (const file of source.files) {
    totalSize += statSync(file.source).size;
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

  const binaryPath = join(
    runtimeRoot,
    "vendor",
    source.triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
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
        `${STAGED_RUNTIME_DIR} (${(totalSize / 1024 / 1024).toFixed(1)} MiB, codex ${source.version})`,
    );
  }
  return {
    runtimeRoot,
    versionPath,
    binaryPath,
    version: source.version,
    triple: source.triple,
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
