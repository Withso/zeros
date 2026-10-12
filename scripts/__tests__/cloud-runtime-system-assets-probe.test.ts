import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, createManifest, inventoryTree, sha256 } from "../cloud-workspace-validation/runtime-bundle/manifest";
import { stageExtractedSystemAssets, type RuntimeAssetPackage } from "../cloud-workspace-validation/runtime-bundle/system-assets";
import { runClosureProbes } from "../cloud-workspace-validation/runtime-bundle/probe";
import * as toolchain from "../cloud-workspace-validation/runtime-bundle/toolchain";

const roots: string[] = [];
const families = [
  ["Noto Color Emoji", "fonts-noto-color-emoji"], ["Unifont", "fonts-unifont"],
  ["IPAGothic", "fonts-ipafont-gothic"], ["WenQuanYi Zen Hei", "fonts-wqy-zenhei"],
  ["Loma", "fonts-tlwg-loma-otf"], ["FreeSans", "fonts-freefont-ttf"],
  ["Bitstream Charter", "xfonts-scalable"], ["Synthetic Cyrillic", "xfonts-cyrillic"],
] as const;
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// A tiny original bitmap font, parsed by real fontconfig. The regular CI test
// needs no network, acquired archive, system font installation or opt-in flag.
function font(family: string) {
  return `STARTFONT 2.1
FONT -zeros-fixture-medium-r-normal--8-80-75-75-c-50-iso10646-1
SIZE 8 75 75
FONTBOUNDINGBOX 5 8 0 0
STARTPROPERTIES 4
FONT_ASCENT 8
FONT_DESCENT 0
FAMILY_NAME "${family}"
WEIGHT_NAME "Regular"
ENDPROPERTIES
CHARS 1
STARTCHAR A
ENCODING 65
SWIDTH 500 0
DWIDTH 5 0
BBX 5 8 0 0
BITMAP
00
70
88
88
F8
88
88
00
ENDCHAR
ENDFONT
`;
}

async function fixture(changeNamespace?: (args: string[]) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-asset-probe-")); roots.push(root);
  const runtime = path.join(root, "runtime"), extracted = new Map<string, string>();
  const packages: RuntimeAssetPackage[] = [];
  for (const [family, name] of [["", "git-lfs"], ...families]) {
    const source = path.join(root, "extracted", name); extracted.set(name, source);
    const asset = path.join(source, name === "git-lfs" ? "usr/bin/git-lfs" : "usr/share/fonts/fixture.bdf");
    await mkdir(path.dirname(asset), { recursive: true });
    await writeFile(asset, name === "git-lfs" ? '#!/bin/sh\nprintf "git-lfs/3.7.1 (synthetic offline fixture)\\n"\n' : font(family),
      { mode: name === "git-lfs" ? 0o755 : 0o644 });
    const copyright = path.join(source, "usr/share/doc", name, "copyright");
    await mkdir(path.dirname(copyright), { recursive: true }); await writeFile(copyright, "Original synthetic fixture");
    packages.push({ name, version: "3.7.1-1", architecture: "all", component: "universe", filename: `pool/fixture/${name}.deb`,
      size: 1, sha256: "a".repeat(64), license: "MIT", copyrightSha256: sha256("Original synthetic fixture") });
  }
  await stageExtractedSystemAssets({ runtime, packages, extracted });
  await copyFile(process.execPath, path.join(runtime, "bin/node"));
  await chmod(path.join(runtime, "bin/node"), 0o555);
  for (const relative of ["bin/start-engine.sh", "lib/zeros/setup-cloud-workspace.mjs", "lib/zeros/cloud-worker-supervisor.mjs"]) {
    await mkdir(path.dirname(path.join(runtime, relative)), { recursive: true });
    await writeFile(path.join(runtime, relative), "", { mode: 0o555 });
  }
  await writeFile(path.join(runtime, "worker/package.json"), "{}");
  await writeFile(path.join(runtime, "manifest.json"), canonicalJson(createManifest({
    source: { commit: "a".repeat(40), lockfileSha256: "b".repeat(64) }, engineProtocolVersion: 43,
    agents: { claude: { sdk: "1", cli: "1" }, codex: { package: "1" }, cursor: { sdk: "1" } },
  }, await inventoryTree(runtime))));

  // Keep the production namespace and actual asset check; this small tree
  // deliberately omits unrelated engine/agent dependencies. Model a runner
  // with a stock LFS in Git's exec-path, which Git searches ahead of PATH.
  const probe = path.join(root, "probe.cjs");
  const source = await readFile("scripts/cloud-workspace-validation/runtime-bundle/probe.cjs", "utf8");
  await writeFile(probe, source.replace("Object.entries(checks)",
    'Object.entries(phase === "engine" ? { runtime_system_assets: checks.runtime_system_assets } : { cursor_load() {} })'));
  const native = execFileSync("/usr/bin/git", ["--exec-path"], {
    cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  const stock = path.join(root, "runner-git-core"); await mkdir(stock);
  for (const name of await readdir(native)) {
    if (name !== "git-lfs") await symlink(`/probe-native-git-core/${name}`, path.join(stock, name));
  }
  await writeFile(path.join(stock, "git-lfs"), '#!/bin/sh\nprintf "git-lfs/0.0.0 (synthetic runner)\\n"\n', { mode: 0o555 });
  const runTool = toolchain.runTool;
  vi.spyOn(toolchain, "runTool").mockImplementation((command, args, options, failure) => {
    if (command !== "setpriv") return runTool(command, args, options, failure);
    const mounted = [...args], entry = mounted.indexOf("/probe.cjs"); mounted[entry - 1] = probe;
    mounted.splice(mounted.indexOf("--symlink"), 0,
      "--ro-bind", native, "/probe-native-git-core", "--ro-bind", stock, native);
    changeNamespace?.(mounted);
    return runTool(command, mounted, options, failure);
  });
  const replace = async (relative: string, value: string) => {
    const file = path.join(runtime, relative); await chmod(file, 0o755); await writeFile(file, value);
  };
  return { runtime, replace };
}

describe.skipIf(process.platform !== "linux")("system assets in the ordinary CI closure namespace", () => {
  it("uses the staged LFS despite a runner exec-path override and matches all seven fonts without /etc", async () => {
    const { runtime } = await fixture();
    await expect(runClosureProbes(runtime)).resolves.toMatchObject({
      checks: ["runtime_system_assets", "cursor_load"], isolation: "mount_namespace_no_network",
    });
  });

  it.each([
    ["inventory", "worker/runtime-system-assets.json", '{"schema":"foreign-error-sentinel"}'],
    ["git_lfs", "bin/git-lfs", '#!/bin/sh\nprintf "foreign-error-sentinel\\n"\n'],
    ["filter", "worker/gitconfig", '[filter "lfs"]\nprocess = foreign-error-sentinel\n'],
  ])("reports the closed %s failure without tool output", async (code, file, value) => {
    const f = await fixture(); await f.replace(file, value);
    const error = await runClosureProbes(f.runtime).catch(error => error);
    expect(error).toMatchObject({
      failedChecks: ["closure_probes", `runtime_system_assets_${code}`,
        ...(code === "git_lfs" ? ["runtime_system_assets_filter"] : [])],
    });
    expect(JSON.stringify(error)).not.toContain("foreign-error-sentinel");
  });

  it("reports a missing file before trying native tools", async () => {
    const f = await fixture(); await rm(path.join(f.runtime, "bin/git-lfs"));
    await expect(runClosureProbes(f.runtime)).rejects.toMatchObject({
      failedChecks: ["closure_probes", "runtime_system_assets_files"],
    });
  });

  it("rejects a process filter that only mentions the pinned executable in a comment", async () => {
    const f = await fixture();
    const command = 'git-lfs filter-process; # "${GIT_CONFIG_SYSTEM%/worker/gitconfig}/bin/git-lfs" filter-process';
    await f.replace("worker/gitconfig", `[filter "lfs"]\nprocess = ${JSON.stringify(command)}\n`);
    await expect(runClosureProbes(f.runtime)).rejects.toMatchObject({
      failedChecks: ["closure_probes", "runtime_system_assets_filter"],
    });
  });

  it.each(["identity", "environment"])("reports a mismatched %s without repairing it inside the check", async code => {
    const f = await fixture(args => {
      if (code === "identity") args[args.indexOf("--uid") + 1] = "10004";
      else args[args.indexOf("GIT_EXEC_PATH") + 1] = "/foreign-git-exec";
    });
    await expect(runClosureProbes(f.runtime)).rejects.toMatchObject({
      failedChecks: ["closure_probes", `runtime_system_assets_${code}`],
    });
  });

  it.each(families.slice(0, 7))("reports the closed package name when %s cannot resolve", async (_family, pkg) => {
    const f = await fixture();
    await f.replace(`worker/design-fonts/${pkg}/fixture.bdf`, font("Foreign fixture family"));
    await expect(runClosureProbes(f.runtime)).rejects.toMatchObject({
      failedChecks: ["closure_probes", `runtime_system_assets_font_${pkg.replaceAll("-", "_")}`],
    });
  });

  it("preserves the historical closure environment when neither asset marker is present", async () => {
    const f = await fixture(args => { expect(args).not.toContain("GIT_EXEC_PATH"); });
    const manifest = JSON.parse(await readFile(path.join(f.runtime, "manifest.json"), "utf8"));
    manifest.files = manifest.files.filter((file: { path: string }) => file.path !== "worker/runtime-system-assets.json");
    await writeFile(path.join(f.runtime, "manifest.json"), canonicalJson(manifest));
    await expect(runClosureProbes(f.runtime)).resolves.toMatchObject({ checks: ["runtime_system_assets", "cursor_load"] });
    expect(vi.mocked(toolchain.runTool).mock.calls.every(([command]) => command === "setpriv")).toBe(true);
  });
});
