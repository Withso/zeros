import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

// Exercise the CLI's real normalizer without launching its package-manager
// inventories or overwriting the repository's license bundle.
const scriptUrl = new URL("../generate-third-party-licenses.mjs", import.meta.url);
const script = readFileSync(scriptUrl, "utf8");
const declarations = script.slice(0, script.indexOf("const rootRecords ="));
const source = ts.transpileModule(
  declarations.replaceAll("import.meta.url", JSON.stringify(scriptUrl.href)),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const normalize = runInNewContext(`${source}\nnormalizePackagedPlatformRecords`, {
  exports: {}, process: { argv: [] }, require: createRequire(fileURLToPath(scriptUrl)),
}) as (records: LicenseRecord[], options: { macosOnly: []; lockfile: string; parentVersions?: Record<string, string> }) => LicenseRecord[];

interface LicenseRecord {
  name: string;
  version: string;
  packagePath: string;
  license: string;
  surfaces: Set<string>;
  documentSourceLabel?: string;
}
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const records: LicenseRecord[] = [];
  const locks: string[] = [];
  for (const [parent, target, spec] of [
    ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk-darwin-arm64", "1.2.3"],
    ["@cursor/sdk", "@cursor/sdk-darwin-arm64", "1.2.3"],
    ["@openai/codex", "@openai/codex-darwin-arm64", "npm:@openai/codex@1.2.3-darwin-arm64"],
    ["@vscode/ripgrep", "@vscode/ripgrep-darwin-arm64", "1.2.3"],
    ["@parcel/watcher", "@parcel/watcher-darwin-arm64", "2.5.6"],
  ]) {
    const packagePath = mkdtempSync(join(tmpdir(), "zeros-license-platform-"));
    directories.push(packagePath);
    writeFileSync(join(packagePath, "package.json"), JSON.stringify({
      name: parent, optionalDependencies: { [target]: spec },
    }));
    records.push({ name: parent, version: parent === "@parcel/watcher" ? "2.5.6" : "1.2.3", packagePath,
      license: "MIT", surfaces: new Set(["root pnpm workspace"]) });
    const key = spec.startsWith("npm:") ? spec.slice(4) : `${target}@${spec}`;
    locks.push(`  '${key}':\n    resolution: {integrity: fixture}`);
  }
  const watcher = records.find(record => record.name === "@parcel/watcher")!;
  const host = (platform: string): LicenseRecord => ({ ...watcher, name: `@parcel/watcher-${platform}` });
  return { records, watcher, host, lockfile: locks.join("\n") };
}

describe("release license platform normalization", () => {
  it("uses the desktop wrapper when a cloud workspace still installs an older runtime", () => {
    const { records, lockfile } = fixture();
    const desktop = records.find(record => record.name === "@anthropic-ai/claude-agent-sdk")!;
    const packagePath = mkdtempSync(join(tmpdir(), "zeros-license-cloud-runtime-"));
    directories.push(packagePath);
    writeFileSync(join(packagePath, "package.json"), JSON.stringify({
      name: desktop.name,
      optionalDependencies: { "@anthropic-ai/claude-agent-sdk-darwin-arm64": "1.2.2" },
    }));
    const cloud = { ...desktop, version: "1.2.2", packagePath };
    const options = {
      macosOnly: [] as [],
      lockfile: `${lockfile}\n  '@anthropic-ai/claude-agent-sdk-darwin-arm64@1.2.2':\n    resolution: {integrity: fixture}`,
      parentVersions: { [desktop.name]: desktop.version },
    };
    const inventory = normalize([cloud, ...records], options);
    const native = (items: LicenseRecord[]) => items.filter(record => record.name === "@anthropic-ai/claude-agent-sdk-darwin-arm64");
    expect(native(inventory)).toEqual(native(normalize([...records, cloud], options)));
    expect(native(inventory))
      .toEqual([expect.objectContaining({ version: desktop.version, packagePath: desktop.packagePath })]);
    expect(inventory).toContainEqual(cloud);
  });

  it("refuses to substitute another workspace's runtime when the desktop wrapper is absent", () => {
    const { records, lockfile } = fixture();
    expect(() => normalize(records, {
      macosOnly: [], lockfile,
      parentVersions: { "@anthropic-ai/claude-agent-sdk": "1.2.4" },
    })).toThrow(/@anthropic-ai\/claude-agent-sdk.*production inventory/);
  });

  it("produces the same shipped watcher inventory on Linux, macOS and hosts without an optional binary", () => {
    const { records, host, watcher, lockfile } = fixture();
    const inventory = (variants: string[]) => normalize([...records, ...variants.map(host)], { macosOnly: [], lockfile });
    const linux = inventory(["linux-x64-glibc", "linux-x64-musl"]);
    expect(linux).toEqual(inventory(["darwin-arm64"]));
    expect(linux).toEqual(inventory([]));
    expect(linux.filter(record => record.name.startsWith("@parcel/watcher-"))).toEqual([
      expect.objectContaining({
        name: "@parcel/watcher-darwin-arm64", version: "2.5.6", license: "MIT", packagePath: watcher.packagePath,
        documentSourceLabel: "@parcel/watcher-darwin-arm64@2.5.6 — terms supplied by @parcel/watcher@2.5.6",
      }),
    ]);
    expect([...linux.find(record => record.name === "@parcel/watcher-darwin-arm64")!.surfaces])
      .toEqual(["desktop packaged runtime (macOS arm64)"]);
  });

  it("rejects a watcher release target absent from the lockfile", () => {
    const { records, lockfile } = fixture();
    expect(() => normalize(records, {
      macosOnly: [], lockfile: lockfile.replace("@parcel/watcher-darwin-arm64@2.5.6", "@parcel/watcher-darwin-arm64@2.5.5"),
    })).toThrow(/@parcel\/watcher-darwin-arm64@2\.5\.6.*missing from pnpm-lock/);
  });
});
