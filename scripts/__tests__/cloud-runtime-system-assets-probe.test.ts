import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, createManifest, inventoryTree, sha256 } from "../cloud-workspace-validation/runtime-bundle/manifest";
import { stageExtractedSystemAssets, type RuntimeAssetPackage } from "../cloud-workspace-validation/runtime-bundle/system-assets";
import { runClosureProbes } from "../cloud-workspace-validation/runtime-bundle/probe";
import * as toolchain from "../cloud-workspace-validation/runtime-bundle/toolchain";
import { scalableFont as font } from "./fixtures/runtime-system-assets/scalable-font";

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

async function fixture(options: {
  changeNamespace?: (args: string[]) => void;
  nested?: boolean;
  warmSystemFonts?: boolean;
  extraFonts?: [string, string][];
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-asset-probe-")); roots.push(root);
  const runtime = path.join(root, "runtime"), extracted = new Map<string, string>();
  const packages: RuntimeAssetPackage[] = [];
  for (const [family, name] of [["", "git-lfs"], ...families]) {
    const source = path.join(root, "extracted", name); extracted.set(name, source);
    const asset = path.join(source, name === "git-lfs" ? "usr/bin/git-lfs" :
      `usr/share/fonts/${options.nested ? "truetype/nested/deeper/" : ""}fixture.ttf`);
    await mkdir(path.dirname(asset), { recursive: true });
    await writeFile(asset, name === "git-lfs" ? '#!/bin/sh\nprintf "git-lfs/3.7.1 (synthetic offline fixture)\\n"\n' : font(family),
      { mode: name === "git-lfs" ? 0o755 : 0o644 });
    const copyright = path.join(source, "usr/share/doc", name, "copyright");
    await mkdir(path.dirname(copyright), { recursive: true }); await writeFile(copyright, "Original synthetic fixture");
    packages.push({ name, version: "3.7.1-1", architecture: "all", component: "universe", filename: `pool/fixture/${name}.deb`,
      size: 1, sha256: "a".repeat(64), license: "MIT", copyrightSha256: sha256("Original synthetic fixture") });
  }
  for (const [family, name] of options.extraFonts ?? []) {
    await writeFile(path.join(extracted.get(name)!, "usr/share/fonts", `${family.replaceAll(" ", "")}.ttf`), font(family));
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
  const warmSystemFonts = `const stockConfig = path.join(process.env.HOME, "stock-fonts.conf");
fs.writeFileSync(stockConfig, '<fontconfig><dir>/usr/share/fonts</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>');
execFileSync("fc-cache", ["--force"], { env: { ...process.env, FONTCONFIG_FILE: stockConfig }, stdio: "pipe" });\n`;
  await writeFile(probe, source.replace("Object.entries(checks)",
    'Object.entries(phase === "engine" ? { runtime_system_assets: checks.runtime_system_assets } : { cursor_load() {} })')
    .replace("const checks = {", `${options.warmSystemFonts ? warmSystemFonts : ""}const checks = {`));
  const native = execFileSync("/usr/bin/git", ["--exec-path"], {
    cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
  const stock = path.join(root, "runner-git-core"); await mkdir(stock);
  for (const name of await readdir(native)) {
    if (name !== "git-lfs") await symlink(`/probe-native-git-core/${name}`, path.join(stock, name));
  }
  await writeFile(path.join(stock, "git-lfs"), '#!/bin/sh\nprintf "git-lfs/0.0.0 (synthetic runner)\\n"\n', { mode: 0o555 });
  // Model stock fonts explicitly, including competitors with higher revisions
  // and unrelated fallback families. The runner's catalog is not fixture data.
  const systemFonts = path.join(root, "system-fonts"); await mkdir(systemFonts);
  const queries: string[] = [], matches: Record<string, string[]> = {};
  const runTool = toolchain.runTool;
  vi.spyOn(toolchain, "runTool").mockImplementation(async (command, args, commandOptions, failure) => {
    if (command !== "setpriv") return runTool(command, args, commandOptions, failure);
    const mounted = [...args], entry = mounted.indexOf("/probe.cjs"); mounted[entry - 1] = probe;
    mounted.splice(mounted.indexOf("--symlink"), 0,
      "--ro-bind", native, "/probe-native-git-core", "--ro-bind", stock, native,
      "--ro-bind", systemFonts, "/usr/share/fonts");
    options.changeNamespace?.(mounted);
    const report = await runTool(command, mounted, commandOptions, failure);
    if (mounted.at(-1) === "engine" && queries.length) {
      const inspect = `const fs = require("node:fs"), { execFileSync } = require("node:child_process");
fs.mkdirSync(process.env.HOME, { recursive: true });
process.stdout.write(JSON.stringify(Object.fromEntries(process.argv.slice(1).map(family => [family,
  execFileSync("fc-match", ["--format=%{file}|%{fontversion}|%{family[0]}", family],
    { encoding: "utf8" }).trim().split("|")]))));`;
      const result = await runTool(command, [...mounted.slice(0, -3), "-e", inspect, ...queries], commandOptions, failure);
      Object.assign(matches, JSON.parse(result));
    }
    return report;
  });
  const replace = async (relative: string, value: string | Uint8Array) => {
    const file = path.join(runtime, relative); await chmod(file, 0o755); await writeFile(file, value);
  };
  return { runtime, replace, systemFonts, queries, matches };
}

describe.skipIf(process.platform !== "linux")("system assets in the ordinary CI closure namespace", () => {
  it("stages distinct scalable font identities for every fixture family", async () => {
    const { runtime } = await fixture();
    const inventory = JSON.parse(await readFile(path.join(runtime, "worker/runtime-system-assets.json"), "utf8"));
    const patterns = inventory.fonts.map((file: string) => execFileSync("/usr/bin/fc-scan", [
      "--format=%{family[0]}|%{postscriptname}|%{scalable}|%{fontformat}|%{charset}", path.join(runtime, file),
    ], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: path.dirname(runtime),
      FONTCONFIG_FILE: path.join(runtime, "worker/design-fonts/fonts.conf") } }).trim().split("|"));
    expect(new Set(patterns.map(([family]: string[]) => family))).toEqual(new Set(families.map(([family]) => family)));
    expect(patterns.every(([, , scalable]: string[]) => scalable === "True")).toBe(true);
    expect(patterns.every(([, postscript]: string[]) => postscript.length > 0)).toBe(true);
    expect(new Set(patterns.map(([, postscript]: string[]) => postscript)).size).toBe(families.length);
    expect(patterns.every(([, , , format, charset]: string[]) => format === "TrueType" && charset === "41")).toBe(true);
  });

  it("uses the staged LFS despite a runner exec-path override and matches all seven fonts without /etc", async () => {
    const { runtime } = await fixture();
    await expect(runClosureProbes(runtime)).resolves.toMatchObject({
      checks: ["runtime_system_assets", "cursor_load"], isolation: "mount_namespace_no_network",
    });
  });

  it("keeps bundled families authoritative over newer stock copies and preserves stock-only families", async () => {
    const f = await fixture({ nested: true, warmSystemFonts: true });
    for (const family of ["Noto Color Emoji", "FreeSans", "Liberation Sans"]) {
      await writeFile(path.join(f.systemFonts, `${family.replaceAll(" ", "")}.ttf`), font(family, 9));
      f.queries.push(family);
    }
    // The config must survive staging under another directory and installation
    // under a content-derived runtime ID, including nested package font paths.
    const config = await readFile(path.join(f.runtime, "worker/design-fonts/fonts.conf"), "utf8");
    expect(config).not.toContain(f.runtime);
    expect(config).not.toMatch(/r1-[a-f0-9]{64}/);
    await expect(runClosureProbes(f.runtime)).resolves.toMatchObject({ checks: ["runtime_system_assets", "cursor_load"] });
    for (const [family, pkg] of [["Noto Color Emoji", "fonts-noto-color-emoji"], ["FreeSans", "fonts-freefont-ttf"]]) {
      expect(f.matches[family][0]).toMatch(new RegExp(`^/opt/zeros-infra/r1-[a-f0-9]{64}/worker/design-fonts/${pkg}/`));
      expect(f.matches[family].slice(1)).toEqual(["65536", family]);
    }
    expect(f.matches["Noto Color Emoji"][0]).toContain("/truetype/nested/deeper/fixture.ttf");
    expect(f.matches["Liberation Sans"]).toEqual(["/usr/share/fonts/LiberationSans.ttf", "589824", "Liberation Sans"]);
  });

  it("also protects bundled families beyond the seven probe queries", async () => {
    const extraFonts: [string, string][] = [["FreeSerif", "fonts-freefont-ttf"], ["FreeMono", "fonts-freefont-ttf"],
      ["IPAPGothic", "fonts-ipafont-gothic"], ["Courier 10 Pitch", "xfonts-scalable"], ["Unifont Sample", "fonts-unifont"]];
    const f = await fixture({ extraFonts });
    for (const [family] of extraFonts) {
      await writeFile(path.join(f.systemFonts, `${family.replaceAll(" ", "")}.ttf`), font(family, 9));
      f.queries.push(family);
    }
    await expect(runClosureProbes(f.runtime)).resolves.toMatchObject({ checks: ["runtime_system_assets", "cursor_load"] });
    for (const [family, pkg] of extraFonts) {
      expect(f.matches[family][0]).toContain(`/worker/design-fonts/${pkg}/`);
      expect(f.matches[family].slice(1)).toEqual(["65536", family]);
    }
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
    const f = await fixture({ changeNamespace: args => {
      if (code === "identity") args[args.indexOf("--uid") + 1] = "10004";
      else args[args.indexOf("GIT_EXEC_PATH") + 1] = "/foreign-git-exec";
    } });
    await expect(runClosureProbes(f.runtime)).rejects.toMatchObject({
      failedChecks: ["closure_probes", `runtime_system_assets_${code}`],
    });
  });

  it.each(families.slice(0, 7))("reports the closed package name when %s cannot resolve", async (_family, pkg) => {
    const f = await fixture();
    await f.replace(`worker/design-fonts/${pkg}/fixture.ttf`, "invalid font fixture");
    await expect(runClosureProbes(f.runtime)).rejects.toMatchObject({
      failedChecks: ["closure_probes", `runtime_system_assets_font_${pkg.replaceAll("-", "_")}`],
    });
  });

  it("refuses a matching system font when its bundled family cannot resolve", async () => {
    const f = await fixture();
    await f.replace("worker/design-fonts/fonts-freefont-ttf/fixture.ttf", font("Foreign fixture family"));
    await writeFile(path.join(f.systemFonts, "stock.ttf"), font("FreeSans"));
    await expect(runClosureProbes(f.runtime)).rejects.toMatchObject({
      failedChecks: ["closure_probes", "runtime_system_assets_font_fonts_freefont_ttf"],
    });
  });

  it("preserves the historical closure environment when neither asset marker is present", async () => {
    const f = await fixture({ changeNamespace: args => { expect(args).not.toContain("GIT_EXEC_PATH"); } });
    const manifest = JSON.parse(await readFile(path.join(f.runtime, "manifest.json"), "utf8"));
    manifest.files = manifest.files.filter((file: { path: string }) => file.path !== "worker/runtime-system-assets.json");
    await writeFile(path.join(f.runtime, "manifest.json"), canonicalJson(manifest));
    await expect(runClosureProbes(f.runtime)).resolves.toMatchObject({ checks: ["runtime_system_assets", "cursor_load"] });
    expect(vi.mocked(toolchain.runTool).mock.calls.every(([command]) => command === "setpriv")).toBe(true);
  });
});
