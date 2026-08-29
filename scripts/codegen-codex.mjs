#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Codex app-server protocol: TS bindings codegen
// ──────────────────────────────────────────────────────────
//
// Why this exists
// ───────────────
//
// Codex defines its JSON-RPC wire format in Rust (serde + ts-rs +
// schemars derives on every protocol struct/enum). Until 2026-05-28
// Zeros hand-transcribed those types into TypeScript at
// `apps/desktop/src/engine/agents/adapters/codex/app-server.ts`. Every Codex bump
// risked silent drift — and twice in three days we shipped wrong
// casing for SandboxPolicy / SandboxMode that the server only
// rejected at runtime. This script eliminates that bug class.
//
// What it does
// ────────────
//
//   1. Read the pinned protocol version from
//        package.json → "codexProtocolVersion".
//   2. Check whether `apps/desktop/src/engine/agents/adapters/codex/generated/.version`
//      already matches that pin. If yes, exit early — codegen output
//      is committed, so a fresh `git pull` already has the right
//      bindings and there's no reason to redo work.
//   3. Otherwise, sparse-clone openai/codex@<tag> into
//        .codex-protocol-cache/<version>/codex/
//      (cached across runs; only the protocol crate is checked out).
//   4. Run the official upstream TypeScript and JSON Schema generators into a
//      sibling staging directory.
//   5. Prune retired bindings, copy upstream notices, and write the version
//      stamp in staging.
//   6. Replace generated/ only after every preceding step succeeds.
//
// Failure modes
// ─────────────
//
// Installed Codex package does not match the protocol pin → fail without
//   touching generated/. Run `pnpm install` before regenerating.
//
// Network down → git can't fetch, returns non-zero. We re-throw so the build
//   fails loudly; a cached checkout remains usable offline.
//
// `gh` / `git` not on PATH → unlikely (project README requires git),
//   surface a clear message and exit non-zero.
//
// Usage
// ─────
//
//   pnpm codegen:codex                  # one-shot regenerate
//   pnpm codegen:codex --force          # ignore the version stamp
//   pnpm codegen:codex --pin=0.135.0    # ad-hoc version override
//
// The script is chained directly into `build:engine`
// (`node scripts/codegen-codex.mjs && tsup`), so a routine build picks
// up bindings without anyone remembering to run it.
//
// ──────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  codexAppServerExportArgs,
  replaceDirectoryTransactionally,
} from "./codegen-codex-lib.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");
const GENERATED_DIR = join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src",
  "engine",
  "agents",
  "adapters",
  "codex",
  "generated",
);
const VERSION_STAMP = join(GENERATED_DIR, ".version");
const CACHE_ROOT = join(REPO_ROOT, ".codex-protocol-cache");
const CODEX_REPO = "https://github.com/openai/codex.git";
const REMOTE_CONTROL_PAIRING_TYPE_PREFIX = "RemoteControl" + "Pairing";
const REMOTE_CONTROL_PAIRING_METHOD_PREFIX = ["remoteControl", "pairing"].join(
  "/",
);
const REMOVED_REMOTE_CONTROL_PAIRING_TYPES = [
  `${REMOTE_CONTROL_PAIRING_TYPE_PREFIX}StartParams`,
  `${REMOTE_CONTROL_PAIRING_TYPE_PREFIX}StartResponse`,
  `${REMOTE_CONTROL_PAIRING_TYPE_PREFIX}StatusParams`,
  `${REMOTE_CONTROL_PAIRING_TYPE_PREFIX}StatusResponse`,
];
const REMOVED_REMOTE_CONTROL_PAIRING_METHODS = [
  `${REMOTE_CONTROL_PAIRING_METHOD_PREFIX}/start`,
  `${REMOTE_CONTROL_PAIRING_METHOD_PREFIX}/status`,
];

// ── flags ────────────────────────────────────────────────

const args = process.argv.slice(2);
const force = args.includes("--force");
const pruneOnly = args.includes("--prune-only");
const pinFlag = args
  .find((a) => a.startsWith("--pin="))
  ?.slice("--pin=".length);

// ── helpers ──────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[codegen-codex] ${msg}\n`);
}

function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    stdio: opts.stdio ?? "inherit",
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${cmdArgs.join(" ")} exited ${result.status}` +
        (opts.cwd ? ` (cwd=${opts.cwd})` : ""),
    );
  }
  return result;
}

function commandExists(cmd) {
  const probe = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [cmd],
    {
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return probe.status === 0;
}

function isEnoent(err) {
  return err && typeof err === "object" && err.code === "ENOENT";
}

function readUtf8IfPresent(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function unlinkIfPresent(file) {
  try {
    unlinkSync(file);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

function readPinnedVersion() {
  if (pinFlag) return pinFlag;
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
  const v = pkg.codexProtocolVersion;
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(
      `package.json is missing "codexProtocolVersion" — add e.g. \`"codexProtocolVersion": "0.134.0"\` so codegen knows which Codex tag to fetch.`,
    );
  }
  return v.trim();
}

function readStamp() {
  try {
    return readUtf8IfPresent(VERSION_STAMP)?.trim() ?? null;
  } catch {
    return null;
  }
}

// ── steps ────────────────────────────────────────────────

function ensureCache(version) {
  const versionDir = join(CACHE_ROOT, version);
  const cloneDir = join(versionDir, "codex");
  mkdirSync(versionDir, { recursive: true });

  if (existsSync(join(cloneDir, ".git"))) {
    log(`cache hit: ${cloneDir}`);
    return cloneDir;
  }

  log(`sparse-cloning openai/codex@rust-v${version} into ${cloneDir}`);
  run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    `rust-v${version}`,
    "--filter=blob:none",
    "--sparse",
    CODEX_REPO,
    cloneDir,
  ]);

  // Restrict the checkout to just the Rust workspace — the rest of
  // the upstream repo (npm packages, docs, etc.) is ~hundreds of MB
  // we don't need.
  run("git", ["sparse-checkout", "set", "codex-rs"], { cwd: cloneDir });
  return cloneDir;
}

function resolveInstalledCodexCli(version) {
  let packagePath;
  try {
    packagePath = require.resolve("@openai/codex/package.json");
  } catch {
    throw new Error(
      "@openai/codex is not installed — run `pnpm install` before codegen",
    );
  }
  const installed = JSON.parse(readFileSync(packagePath, "utf8"));
  if (installed.version !== version) {
    throw new Error(
      `installed @openai/codex ${String(installed.version)} does not match ` +
        `codexProtocolVersion ${version} — run \`pnpm install\``,
    );
  }
  return join(dirname(packagePath), "bin", "codex.js");
}

function runExport(codexCli, outDir) {
  mkdirSync(outDir, { recursive: true });

  log(`running the pinned Codex app-server schema generators…`);
  for (const command of codexAppServerExportArgs(outDir)) {
    run(process.execPath, [codexCli, ...command], { cwd: REPO_ROOT });
  }
}

function copyUpstreamLegalFiles(cloneDir, generatedDir) {
  for (const name of ["LICENSE", "NOTICE"]) {
    const source = join(cloneDir, name);
    if (!existsSync(source)) {
      throw new Error(`openai/codex checkout is missing its ${name} file`);
    }
    copyFileSync(source, join(generatedDir, name));
  }
}

function writeStamp(version, generatedDir) {
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(
    join(generatedDir, ".version"),
    `${version}\n` +
      `# This file is auto-generated by scripts/codegen-codex.mjs.\n` +
      `# Run \`pnpm codegen:codex\` to refresh after bumping ` +
      `package.json#codexProtocolVersion.\n`,
    "utf8",
  );
}

function stripPairingSchemaNode(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    return node.map(stripPairingSchemaNode).filter((item) => {
      const encoded = JSON.stringify(item);
      return (
        !REMOVED_REMOTE_CONTROL_PAIRING_METHODS.some((method) =>
          encoded.includes(method),
        ) &&
        !REMOVED_REMOTE_CONTROL_PAIRING_TYPES.some((typeName) =>
          encoded.includes(typeName),
        )
      );
    });
  }
  for (const key of Object.keys(node)) {
    node[key] = stripPairingSchemaNode(node[key]);
  }
  return node;
}

function prunePairingFromJson(file) {
  const text = readUtf8IfPresent(file);
  if (text == null) return;
  const json = JSON.parse(text);
  const definitions = json.definitions;
  if (definitions && typeof definitions === "object") {
    for (const typeName of REMOVED_REMOTE_CONTROL_PAIRING_TYPES) {
      delete definitions[typeName];
      delete definitions[`v2/${typeName}`];
      if (definitions.v2 && typeof definitions.v2 === "object") {
        delete definitions.v2[typeName];
      }
    }
  }
  stripPairingSchemaNode(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

function prunePairingFromTs(file) {
  let text = readUtf8IfPresent(file);
  if (text == null) return;
  for (const typeName of REMOVED_REMOTE_CONTROL_PAIRING_TYPES) {
    text = text.replace(
      new RegExp(
        `^import type \\{ ${typeName} \\} from "\\./v2/${typeName}";\\n`,
        "m",
      ),
      "",
    );
    text = text.replace(
      new RegExp(
        `^export type \\{ ${typeName} \\} from "\\./${typeName}";\\n`,
        "m",
      ),
      "",
    );
  }
  text = text.replace(
    new RegExp(
      `\\s*\\| \\{ "method": "${REMOVED_REMOTE_CONTROL_PAIRING_METHODS[0].replaceAll("/", "\\/")}", id: RequestId, params: ${REMOVED_REMOTE_CONTROL_PAIRING_TYPES[0]}, \\}`,
    ),
    "",
  );
  text = text.replace(
    new RegExp(
      `\\s*\\| \\{ "method": "${REMOVED_REMOTE_CONTROL_PAIRING_METHODS[1].replaceAll("/", "\\/")}", id: RequestId, params: ${REMOVED_REMOTE_CONTROL_PAIRING_TYPES[2]}, \\}`,
    ),
    "",
  );
  writeFileSync(file, text, "utf8");
}

function pruneRetiredPairingBindings(generatedDir = GENERATED_DIR) {
  // Zeros removed its web/relay pairing surface. Upstream Codex still exports
  // remote-control pairing types, so prune them after codegen to avoid
  // reintroducing a dead local API whenever the protocol bindings refresh.
  prunePairingFromTs(join(generatedDir, "ClientRequest.ts"));
  prunePairingFromTs(join(generatedDir, "v2", "index.ts"));
  for (const file of [
    join(generatedDir, "ClientRequest.json"),
    join(generatedDir, "codex_app_server_protocol.schemas.json"),
    join(generatedDir, "codex_app_server_protocol.v2.schemas.json"),
  ]) {
    prunePairingFromJson(file);
  }
  for (const typeName of REMOVED_REMOTE_CONTROL_PAIRING_TYPES) {
    for (const ext of [".ts", ".json"]) {
      const file = join(generatedDir, "v2", `${typeName}${ext}`);
      unlinkIfPresent(file);
    }
  }
}

// ── main ─────────────────────────────────────────────────

function main() {
  if (pruneOnly) {
    pruneRetiredPairingBindings();
    log(`retired pairing bindings pruned from ${GENERATED_DIR}`);
    return;
  }

  const version = readPinnedVersion();
  const existingStamp = readStamp()?.split("\n")[0] ?? null;

  if (!force && existingStamp === version) {
    log(`bindings already at ${version}; skipping (use --force to regenerate)`);
    return;
  }

  log(
    `target version: ${version}` +
      (existingStamp ? ` (currently: ${existingStamp})` : ""),
  );

  if (!commandExists("git")) {
    throw new Error("`git` not on PATH — required to fetch Codex source.");
  }
  const codexCli = resolveInstalledCodexCli(version);
  const cloneDir = ensureCache(version);

  replaceDirectoryTransactionally(GENERATED_DIR, (stagingDir) => {
    runExport(codexCli, stagingDir);
    pruneRetiredPairingBindings(stagingDir);
    copyUpstreamLegalFiles(cloneDir, stagingDir);
    writeStamp(version, stagingDir);
  });
  log(`bindings written to ${GENERATED_DIR}`);
}

try {
  main();
} catch (err) {
  log(`failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
