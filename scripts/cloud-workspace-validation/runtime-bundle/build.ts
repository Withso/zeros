import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeRuntimeArchive } from "./archive";
import {
  copyPayload,
  PayloadScanError,
  scanPayload,
  stageDependencyClosure,
  stageSources,
  within,
  writeDependencyInventory,
} from "./closure";
import {
  BundleError,
  canonicalJson,
  check,
  createManifest,
  inventoryTree,
  PLAYWRIGHT_VERSION,
  PNPM_VERSION,
  sha256,
  sha256File,
} from "./manifest";
import {
  buildEnvironment,
  inspectNativeRequirements,
  prepareToolchain,
  runTool,
} from "./toolchain";
import { verifyBundleDirectory } from "./verify";

export function buildPathPrefixes(paths: {
  work: string;
  sourceDir: string;
  outDir: string;
}): string[] {
  // All build subprocesses use a private HOME/store/cache below work. The
  // operator's HOME is not a build root: vendor executables can independently
  // contain that prefix (notably /home/runner) in upstream compiler provenance.
  return [paths.work, paths.sourceDir, paths.outDir];
}

export function diagnostic(stage: string, error?: unknown): void {
  if (
    stage === "scan_payload" &&
    error instanceof PayloadScanError &&
    error.entry
  )
    console.error(
      JSON.stringify({ stage, check: error.check, entry: error.entry }),
    );
  const failure = error as
    | { exitCode?: number; timedOut?: boolean; failedChecks?: string[] }
    | undefined;
  console.log(
    JSON.stringify({
      schema: "zeros.diagnostic/v1",
      component: "bundle",
      stage,
      ok: error === undefined,
      exitCode: error === undefined ? 0 : (failure?.exitCode ?? null),
      timedOut: failure?.timedOut === true,
      failedChecks:
        error === undefined
          ? []
          : (failure?.failedChecks ?? [
              error instanceof BundleError ? error.check : "unexpected_failure",
            ]),
    }),
  );
}

export async function buildRuntimeBundle(options: {
  sourceDir: string;
  outDir: string;
  sourceCommit?: string;
  workDir?: string;
  progress?: (stage: string) => void;
}): Promise<unknown> {
  const started = performance.now();
  const sourceDir = await realpath(options.sourceDir);
  const outDir = path.resolve(options.outDir);
  check(
    process.platform === "linux" && process.arch === "x64",
    "native_platform",
  );
  check(!within(outDir, sourceDir), "output_path");
  // Only these tools inspect the operator checkout. Build scripts receive a
  // fresh git archive, isolated HOME/store and a credential-free environment.
  const initialEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" };
  const gitOptions = { cwd: sourceDir, env: initialEnv };
  check(
    (await runTool(
      "git",
      ["rev-parse", "--show-toplevel"],
      gitOptions,
      "source_checkout",
    )) === sourceDir,
    "source_checkout",
  );
  const sourceCommit = await runTool(
    "git",
    ["rev-parse", "HEAD"],
    gitOptions,
    "source_commit",
  );
  check(
    /^[a-f0-9]{40}$/.test(sourceCommit) &&
      (!options.sourceCommit || options.sourceCommit === sourceCommit),
    "source_commit",
  );
  check(
    (await runTool(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      gitOptions,
      "source_clean",
    )) === "",
    "source_clean",
  );
  const work = options.workDir
    ? path.resolve(options.workDir)
    : await mkdtemp(path.join(os.tmpdir(), "zeros-runtime-build-"));
  check(
    !within(work, sourceDir) && !within(work, outDir) && !within(outDir, work),
    "work_path",
  );
  if (options.workDir) {
    await mkdir(path.dirname(work), { recursive: true });
    await mkdir(work);
  }
  let outputCreated = false;
  const durations: Record<string, number> = {};
  async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await run();
      options.progress?.(name);
      return result;
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new BundleError("unexpected_failure"),
        { stage: name },
      );
    } finally {
      durations[name] = Math.round(performance.now() - start);
    }
  }
  const previousUmask = process.umask(0o022);
  try {
    await mkdir(path.dirname(outDir), { recursive: true });
    await mkdir(outDir);
    outputCreated = true;
    const env = buildEnvironment(work);
    const tools = await stage("prepare_toolchain", () =>
      prepareToolchain(work, env),
    );
    const checkout = path.join(work, "checkout");
    await stage("prepare_source", async () => {
      await mkdir(checkout);
      const archive = path.join(work, "source.tar");
      await runTool(
        "git",
        ["archive", "--format=tar", "--output", archive, sourceCommit],
        gitOptions,
        "source_archive",
      );
      await runTool(
        "tar",
        ["-xf", archive, "-C", checkout, "--no-same-owner"],
        { cwd: work, env },
        "source_archive",
      );
      await rm(archive);
    });
    const command = { cwd: checkout, env };
    const rootPackage = JSON.parse(
      await readFile(path.join(checkout, "package.json"), "utf8"),
    );
    check(
      rootPackage.packageManager === `pnpm@${PNPM_VERSION}`,
      "pnpm_version",
    );
    check(
      rootPackage.dependencies["playwright-core"] === PLAYWRIGHT_VERSION,
      "playwright_pin",
    );
    const lockfileSha256 = await sha256File(
      path.join(checkout, "pnpm-lock.yaml"),
    );
    await stage("install_dependencies", async () => {
      await runTool(
        tools.pnpm,
        [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--store-dir",
          path.join(work, "pnpm-store"),
          "--config.package-import-method=copy",
        ],
        command,
        "dependency_install",
      );
      check(
        (await sha256File(path.join(checkout, "pnpm-lock.yaml"))) ===
          lockfileSha256,
        "lockfile_changed",
      );
    });
    const fromCheckout = createRequire(path.join(checkout, "package.json"));
    await stage("build_runtime", async () => {
      for (const name of ["better-sqlite3", "node-pty"]) {
        // Both packages can prefer a shipped prebuild over a source build.
        // Remove those only in the disposable dependency installation.
        await rm(path.join(checkout, "node_modules", name, "prebuilds"), {
          recursive: true,
          force: true,
        });
      }
      await runTool(
        tools.pnpm,
        ["rebuild", "better-sqlite3", "node-pty"],
        command,
        "native_rebuild",
      );
      const fromRebuild = createRequire(
        fromCheckout.resolve("@electron/rebuild"),
      );
      const nodeGyp = fromRebuild.resolve("node-gyp/bin/node-gyp.js");
      tools.versions["node-gyp"] = JSON.parse(
        await readFile(
          path.join(path.dirname(nodeGyp), "../package.json"),
          "utf8",
        ),
      ).version;
      for (const name of ["esbuild", "tsup", "typescript", "playwright-core"]) {
        tools.versions[name] = JSON.parse(
          await readFile(
            path.join(checkout, "node_modules", name, "package.json"),
            "utf8",
          ),
        ).version;
      }
      // better-sqlite3 13 has gypfile:false and no install hook; `pnpm rebuild`
      // alone silently leaves it unbuilt. Invoke the lockfile's node-gyp.
      for (const name of ["better-sqlite3", "node-pty"]) {
        const cwd = await realpath(path.join(checkout, "node_modules", name));
        await runTool(
          tools.node,
          [
            nodeGyp,
            "rebuild",
            "--release",
            "--force_build=1",
            "--jobs=2",
            `--nodedir=${tools.nodeDirectory}`,
          ],
          { ...command, cwd },
          "native_rebuild",
        );
      }
      await runTool(
        tools.node,
        [
          "-e",
          'const db=require("better-sqlite3")();db.prepare("SELECT 1").get();db.close();require("node-pty");',
        ],
        command,
        "native_load",
      );
      await runTool(
        tools.pnpm,
        ["build:zsr-supervisor"],
        command,
        "supervisor_build",
      );
      await runTool(tools.pnpm, ["build:engine"], command, "engine_build");
    });
    const browsers = path.join(work, "browser-downloads");
    await stage("download_browsers", async () => {
      await runTool(
        tools.pnpm,
        ["exec", "playwright-core", "install", "chromium"],
        {
          ...command,
          env: {
            ...env,
            PLAYWRIGHT_BROWSERS_PATH: browsers,
            PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "ubuntu24.04-x64",
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "0",
            PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT: "120000",
          },
        },
        "browser_download",
      );
    });
    const runtime = path.join(work, "runtime");
    await mkdir(runtime);
    const packages = await stage("stage_payload", async () => {
      await stageSources(checkout, runtime);
      const packages = await stageDependencyClosure(checkout, runtime);
      for (const library of ["protocol", "design-core", "design-web"]) {
        check(
          packages.some((entry) => entry.path === `worker/packages/${library}`),
          "workspace_closure",
        );
      }
      await copyPayload(
        path.join(checkout, "dist-engine"),
        path.join(runtime, "worker/dist-engine"),
      );
      for (const name of ["zsr-supervisor.mjs", "zsr-rg"])
        await copyPayload(
          path.join(checkout, "binaries", name),
          path.join(runtime, "worker/binaries", name),
        );
      await copyPayload(tools.node, path.join(runtime, "bin/node"));
      await copyPayload(
        path.join(tools.nodeDirectory, "LICENSE"),
        path.join(runtime, "lib/node/LICENSE"),
      );
      await writeFile(
        path.join(runtime, "lib/node/provenance.json"),
        canonicalJson({
          version: tools.versions.node,
          source: tools.nodeArchiveUrl,
          archiveSha256: tools.nodeArchiveSha256,
        }),
        { mode: 0o444, flag: "wx" },
      );
      for (const [name, source, mode] of [
        [
          "cloud-engine-namespace",
          "scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c",
          0o500,
        ],
        [
          "cloud-process-supervisor",
          "apps/desktop/src/engine/agents/containment/cloud-process-supervisor.c",
          0o555,
        ],
      ] as const) {
        await runTool(
          "cc",
          [
            "-std=c11",
            "-O2",
            "-Wall",
            "-Wextra",
            "-Werror",
            source,
            "-o",
            path.join(runtime, "bin", name),
          ],
          command,
          "helper_build",
        );
        await chmod(path.join(runtime, "bin", name), mode);
      }
      await copyPayload(
        browsers,
        path.join(runtime, "worker/design-browsers"),
        (name) => name === ".links" || name.endsWith("/DEPENDENCIES_VALIDATED"),
      );
      await writeFile(
        path.join(runtime, "worker/design-browsers/NOTICE.txt"),
        `Chromium assets selected by playwright-core ${PLAYWRIGHT_VERSION} for Ubuntu 24.04 x64.\n` +
          "All downloaded browser resources and upstream notices are retained, including ABOUT, LICENSE.headless_shell and WidevineCdm/LICENSE.\n" +
          "Playwright's license is retained in worker/node_modules/playwright-core/LICENSE.\n",
        { mode: 0o444, flag: "wx" },
      );
      await writeDependencyInventory(runtime, packages);
      return packages;
    });
    // Inventory is read back from the final copied tree, not inferred from pnpm.
    const entries = await stage("inventory_payload", () =>
      inventoryTree(runtime),
    );
    const nativeRequirements = await stage("verify_abi", () =>
      inspectNativeRequirements(runtime, entries, env),
    );
    const forbiddenPaths = buildPathPrefixes({ work, sourceDir, outDir });
    await stage("scan_payload", () => scanPayload(runtime, forbiddenPaths));
    const claude = JSON.parse(
      await readFile(
        path.join(
          checkout,
          "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
        ),
        "utf8",
      ),
    );
    const protocolSource = await readFile(
      path.join(checkout, "packages/protocol/src/version.ts"),
      "utf8",
    );
    const protocol = /export const PROTOCOL_VERSION = (\d+) as const;/.exec(
      protocolSource,
    );
    check(protocol, "engine_protocol");
    const manifest = createManifest(
      {
        source: { commit: sourceCommit, lockfileSha256 },
        engineProtocolVersion: Number(protocol[1]),
        agents: {
          claude: { sdk: claude.version, cli: claude.claudeCodeVersion },
          codex: { package: rootPackage.dependencies["@openai/codex"] },
          cursor: { sdk: rootPackage.dependencies["@cursor/sdk"] },
        },
      },
      entries,
    );
    const manifestBytes = canonicalJson(manifest);
    const manifestSha256 = sha256(manifestBytes),
      runtimeId = `r1-${manifestSha256}`;
    const archivePath = path.join(outDir, `${runtimeId}.tar.gz`);
    await stage("write_archive", async () => {
      await writeRuntimeArchive(runtime, manifestBytes, archivePath);
      await writeFile(path.join(outDir, "manifest.json"), manifestBytes, {
        flag: "wx",
        mode: 0o644,
      });
      const { stat } = await import("node:fs/promises");
      const descriptor = {
        runtimeId,
        manifestSha256,
        archiveSha256: await sha256File(archivePath),
        archiveBytes: (await stat(archivePath)).size,
        expandedBytes: entries.reduce(
          (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
          0,
        ),
        sourceCommit,
        nodeModulesAbi: manifest.platform.nodeModulesAbi,
        bootstrapProtocolVersion: manifest.protocols.bootstrap,
        engineProtocolVersion: manifest.protocols.engine,
      };
      await writeFile(
        path.join(outDir, "descriptor.json"),
        canonicalJson(descriptor),
        { flag: "wx", mode: 0o644 },
      );
    });
    const verified = await stage("verify_bundle", () =>
      verifyBundleDirectory(outDir, true),
    );
    const files = entries.filter((entry) => entry.type === "file");
    const receipt = {
      schema: "zeros.runtime-build-receipt/v1",
      ...verified.descriptor,
      fileCount: files.length,
      entryCount: entries.length,
      dependencyCount: packages.length,
      largestEntries: [...files]
        .sort(
          (a, b) =>
            b.size - a.size ||
            Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
        )
        .slice(0, 15)
        .map(({ path, size }) => ({ path, size })),
      exceedsSizeGuidance: verified.descriptor.expandedBytes > 2.5 * 1024 ** 3,
      durationsMs: {
        ...durations,
        total: Math.round(performance.now() - started),
      },
      toolchain: tools.versions,
      nativeRequirements,
      closure: verified.closure,
    };
    const receiptBytes = canonicalJson(receipt);
    check(
      !forbiddenPaths.some((hostPath) =>
        receiptBytes.includes(Buffer.from(hostPath)),
      ),
      "build_path",
    );
    await writeFile(path.join(outDir, "build-receipt.json"), receiptBytes, {
      flag: "wx",
      mode: 0o644,
    });
    check((await readdir(outDir)).length === 4, "output_inventory");
    return receipt;
  } catch (error) {
    if (outputCreated) await rm(outDir, { recursive: true, force: true });
    throw error;
  } finally {
    process.umask(previousUmask);
    // An explicit work directory is a local debugging aid, never an artifact.
    if (!options.workDir) await rm(work, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let currentStage = "validate_source";
  void (async () => {
    const { values } = parseArgs({
      options: {
        "out-dir": { type: "string" },
        "source-commit": { type: "string" },
        "work-dir": { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
    });
    if (values.help) {
      console.log(
        "Usage: pnpm cloud:runtime-bundle:build --out-dir <new-directory> [--source-commit <exact-HEAD>] [--work-dir <new-scratch-directory>]",
      );
      return;
    }
    check(values["out-dir"], "input_schema");
    await buildRuntimeBundle({
      sourceDir: process.cwd(),
      outDir: values["out-dir"],
      sourceCommit: values["source-commit"],
      workDir: values["work-dir"],
      progress: (stage) => {
        currentStage = stage;
        diagnostic(stage);
      },
    });
    diagnostic("done");
  })().catch((error: unknown) => {
    const stage = (error as { stage?: string })?.stage ?? currentStage;
    diagnostic(stage, error);
    process.exitCode = 1;
  });
}
