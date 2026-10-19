import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRuntimeBundle } from "../cloud-workspace-validation/runtime-bundle/build";
import { canonicalJson, createManifest, inventoryTree, PLAYWRIGHT_VERSION, PNPM_VERSION } from "../cloud-workspace-validation/runtime-bundle/manifest";
import { runClosureProbes } from "../cloud-workspace-validation/runtime-bundle/probe";
import * as toolchain from "../cloud-workspace-validation/runtime-bundle/toolchain";

const require = createRequire(import.meta.url);
const playwrightRoot = path.dirname(require.resolve("playwright-core/package.json"));
const browsers = require(path.join(playwrightRoot, "browsers.json")).browsers as { name: string; revision: string; browserVersion?: string }[];
const headless = browsers.find(browser => browser.name === "chromium-headless-shell")!;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-browser-closure-"));
  roots.push(root);
  return root;
}

describe.skipIf(process.platform !== "linux")("cloud runtime browser closure", () => {
  it("the real builder asks the pinned installer for only headless shell and FFmpeg", async () => {
    const root = await scratch(), sourceDir = path.join(root, "source"), work = path.join(root, "work");
    await mkdir(sourceDir);
    const runTool = toolchain.runTool;
    const stop = new Error("fixture reached browser staging");
    let plan = "";
    vi.spyOn(toolchain, "prepareToolchain").mockResolvedValue({
      node: process.execPath, nodeDirectory: path.dirname(process.execPath), pnpm: "fixture-pnpm",
      nodeArchiveSha256: "a".repeat(64), nodeArchiveUrl: "https://example.invalid/node.tar.xz", versions: {},
    });
    // Only unrelated compilation/downloads are synthetic. The builder reaches
    // its normal download stage, whose exact argv runs the pinned CLI's dry-run.
    vi.spyOn(toolchain, "runTool").mockImplementation(async (command, args, options, check) => {
      if (check === "source_checkout") return sourceDir;
      if (check === "source_commit") return "a".repeat(40);
      if (check === "source_clean") return "";
      if (check === "source_archive" && command === "git") {
        await writeFile(path.join(work, "source.tar"), "fixture source archive");
        return "";
      }
      if (check === "source_archive" && command === "tar") {
        const checkout = path.join(work, "checkout");
        await writeFile(path.join(checkout, "package.json"), JSON.stringify({
          packageManager: `pnpm@${PNPM_VERSION}`, dependencies: { "playwright-core": PLAYWRIGHT_VERSION },
        }));
        await writeFile(path.join(checkout, "pnpm-lock.yaml"), "fixture unchanged lockfile");
        for (const name of ["better-sqlite3", "node-pty", "@electron/rebuild", "node-gyp", "esbuild", "tsup", "typescript", "playwright-core"]) {
          const target = path.join(checkout, "node_modules", name);
          await mkdir(target, { recursive: true });
          await writeFile(path.join(target, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
          await writeFile(path.join(target, "index.js"), "");
        }
        await mkdir(path.join(checkout, "node_modules/node-gyp/bin"));
        await writeFile(path.join(checkout, "node_modules/node-gyp/bin/node-gyp.js"), "");
        return "";
      }
      if (check === "browser_download") {
        expect(command).toBe("fixture-pnpm");
        expect(args.slice(0, 2)).toEqual(["exec", "playwright-core"]);
        expect(options.env).toMatchObject({
          PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: "ubuntu24.04-x64",
          PLAYWRIGHT_BROWSERS_PATH: path.join(work, "browser-downloads"),
        });
        plan = await runTool(process.execPath, [path.join(playwrightRoot, "cli.js"), ...args.slice(2), "--dry-run"],
          { ...options, timeout: 10_000 }, "browser_plan");
        return "";
      }
      if (["dependency_install", "native_rebuild", "native_load", "supervisor_build", "engine_build", "qualification_build"].includes(check)) return "";
      throw new Error(`Unexpected fixture stage: ${check}`);
    });
    await expect(buildRuntimeBundle({ sourceDir, outDir: path.join(root, "out"), workDir: work,
      progress: stage => { if (stage === "download_browsers") throw stop; },
    })).rejects.toBe(stop);
    const locations = [...plan.matchAll(/Install location:\s+(.+)/g)].map(match => path.basename(match[1]));
    expect(new Set(locations)).toEqual(new Set([
      `chromium_headless_shell-${headless.revision}`,
      `ffmpeg-${browsers.find(browser => browser.name === "ffmpeg")!.revision}`,
    ]));
  });

  async function probeFixture(fullChrome = false) {
    const root = await scratch(), runtime = path.join(root, "runtime"), worker = path.join(runtime, "worker");
    await chmod(root, 0o755);
    await mkdir(path.join(runtime, "bin"), { recursive: true });
    await mkdir(path.join(worker, "node_modules"), { recursive: true });
    await cp(playwrightRoot, path.join(worker, "node_modules/playwright-core"), { recursive: true });
    await copyFile(process.execPath, path.join(runtime, "bin/node"));
    await chmod(path.join(runtime, "bin/node"), 0o555);
    await writeFile(path.join(worker, "package.json"), "{}");
    for (const file of ["bin/start-engine.sh", "lib/zeros/setup-cloud-workspace.mjs", "lib/zeros/cloud-worker-supervisor.mjs"]) {
      await mkdir(path.dirname(path.join(runtime, file)), { recursive: true });
      await writeFile(path.join(runtime, file), "", { mode: 0o555 });
    }
    const shell = path.join(worker, "design-browsers", `chromium_headless_shell-${headless.revision}`, "chrome-headless-shell-linux64/chrome-headless-shell");
    await mkdir(path.dirname(shell), { recursive: true });
    await writeFile(shell, `#!/bin/sh\nprintf 'Google Chrome for Testing ${headless.browserVersion}\\n'\n`, { mode: 0o555 });
    await writeFile(path.join(path.dirname(shell), "LICENSE.headless_shell"), "Original synthetic fixture");
    await writeFile(path.join(worker, "design-browsers/NOTICE.txt"), "Original synthetic fixture");
    if (fullChrome) {
      const full = path.join(worker, "design-browsers", `chromium-${headless.revision}`, "chrome-linux64/chrome");
      await mkdir(path.dirname(full), { recursive: true });
      await copyFile(shell, full);
    }
    await writeFile(path.join(runtime, "manifest.json"), canonicalJson(createManifest({
      source: { commit: "a".repeat(40), lockfileSha256: "b".repeat(64) }, engineProtocolVersion: 43,
      agents: { claude: { sdk: "1", cli: "1" }, codex: { package: "1" }, cursor: { sdk: "1" } },
    }, await inventoryTree(runtime))));
    // Keep the production probe and namespace. Only unrelated checks are
    // excluded from this deliberately small, offline closure fixture.
    const source = await readFile("scripts/cloud-workspace-validation/runtime-bundle/probe.cjs", "utf8");
    expect(source).toContain("Object.entries(checks)");
    const probe = path.join(root, "browser-probe.cjs");
    await writeFile(probe, source.replace("Object.entries(checks)",
      'Object.entries(phase === "engine" ? { browser_assets: checks.browser_assets } : { cursor_load() {} })'));
    const runTool = toolchain.runTool;
    vi.spyOn(toolchain, "runTool").mockImplementation((command, args, options, check) => {
      if (command !== "setpriv") return runTool(command, args, options, check);
      const mounted = [...args];
      expect(mounted[mounted.indexOf("--uid") + 1]).toBe("10003");
      expect(mounted).toContain("--unshare-net");
      mounted[mounted.indexOf("/probe.cjs") - 1] = probe;
      return runTool(command, mounted, options, check);
    });
    return { runtime, shell };
  }

  it("accepts the pinned headless shell with full Chromium absent in the readonly engine view", async () => {
    const { runtime } = await probeFixture();
    await expect(runClosureProbes(runtime)).resolves.toMatchObject({
      checks: ["browser_assets", "cursor_load"], isolation: "mount_namespace_no_network",
    });
  });

  it.each(["missing", "not-executable", "wrong-version", "outside-runtime", "outside-browser-tree"] as const)(
    "refuses a %s headless executable even if full Chromium is present", async kind => {
      const { runtime, shell } = await probeFixture(true);
      if (kind === "missing") await rm(shell);
      else if (kind === "not-executable") await chmod(shell, 0o444);
      else if (kind === "wrong-version") {
        await chmod(shell, 0o755);
        await writeFile(shell, "#!/bin/sh\nprintf 'Google Chrome for Testing 0.0.0.0\\n'\n");
      } else {
        await rm(shell);
        await symlink(kind === "outside-runtime" ? "/usr/bin/true" : "../../../../bin/node", shell);
      }
      await expect(runClosureProbes(runtime)).rejects.toMatchObject({ failedChecks: ["closure_probes", "browser_assets"] });
    },
  );
});
