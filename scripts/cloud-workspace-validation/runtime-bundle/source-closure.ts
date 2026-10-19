import { build, type Metafile } from "esbuild";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { forbiddenPayloadPath, HARNESS_ROOTS, ROOT_METADATA, SOURCE_SLICES, within } from "./closure";
import { byteOrder, check, validPath, type ManifestEntry } from "./manifest";

const ENGINE = "apps/desktop/src/engine";
const CODE_SLICES = [
  ENGINE,
  "scripts/cloud-workspace-validation/sandbox",
  "scripts/cloud-workspace-validation/lib",
];

// These are resolved by name, command path or createRequire at runtime, so
// they need roots even when esbuild cannot see an ordinary import. Keep their
// complete package closure: native payloads, LSP declarations and data files
// are not disposable just because they are absent from a JavaScript graph.
export const CLOUD_COMMAND_ROOTS = [
  "@anthropic-ai/claude-agent-sdk",
  "@cursor/sdk",
  "@openai/codex",
  "@vscode/ripgrep",
  "better-sqlite3",
  "node-pty",
  "pyright",
  "smol-toml",
  "ssh2",
  "typescript-language-server",
  ...HARNESS_ROOTS,
];

export type CloudSourceClosure = {
  schema: "zeros.cloud-source-closure/v1";
  entryPoints: string[];
  sourceFiles: string[];
  dependencyRoots: string[];
  inputs: Metafile["inputs"];
};

// Measured after selecting runtime roots. Applies only to newly built cloud
// source/package payloads; historical archive acceptance limits are unchanged.
export const CLOUD_SOURCE_BUDGET = { bytes: 1000 * 1024 ** 2, entries: 23_000 } as const;
export function enforceCloudSourceBudget(entries: readonly ManifestEntry[]): { bytes: number; entries: number } {
  const roots = ["worker/node_modules", "worker/apps", "worker/packages", "worker/dist-engine"];
  const selected = entries.filter(entry => entry.path === "worker/runtime-source-closure.json" ||
    roots.some(root => entry.path === root || entry.path.startsWith(`${root}/`)));
  const bytes = selected.reduce((sum, entry) => sum + (entry.type === "file" ? entry.size : 0), 0);
  check(bytes <= CLOUD_SOURCE_BUDGET.bytes, "source_closure_bytes");
  check(selected.length <= CLOUD_SOURCE_BUDGET.entries, "source_closure_entries");
  return { bytes, entries: selected.length };
}

function sourceTest(relative: string): boolean {
  return relative.split("/").some(part => ["__tests__", "__fixtures__", "tests"].includes(part)) ||
    /\.(?:test|spec)\.[^.]+$/.test(relative);
}

/** Discover the complete retained source graph, including standalone child
 * entries, without executing it or changing the source qualification path.
 * Node packages stay external here and retain their own declared dependency
 * graph. This is an inventory pass, not a replacement qualification bundle. */
export async function planCloudSourceClosure(source: string): Promise<CloudSourceClosure> {
  source = await realpath(source);
  const files: string[] = [];
  async function visit(relative: string): Promise<void> {
    if (forbiddenPayloadPath(relative) || sourceTest(relative) || relative.split("/").includes("node_modules")) return;
    check(validPath(relative), "source_path");
    const input = path.join(source, relative);
    const info = await lstat(input);
    if (info.isDirectory()) {
      for (const name of (await readdir(input)).sort(byteOrder)) await visit(`${relative}/${name}`);
    } else {
      // The sandbox has file aliases to the canonical engine helpers. Keep
      // their names but never let the graph read an external checkout.
      const actual = await realpath(input);
      check(within(source, actual) && (await lstat(actual)).isFile(), "source_path");
      files.push(relative);
    }
  }
  for (const slice of CODE_SLICES) await visit(slice);
  await visit("apps/desktop/src/cli.ts");
  const entryPoints = files.filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !/\.d\.[cm]?ts$/.test(file)).sort(byteOrder);
  const result = await build({
    absWorkingDir: source,
    entryPoints,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    write: false,
    outdir: ".cloud-source-closure",
    metafile: true,
    logLevel: "silent",
  });
  check(result.warnings.length === 0, "source_closure");
  const inputs: Metafile["inputs"] = {};
  const dependencyRoots = new Set(CLOUD_COMMAND_ROOTS);
  const sourceFiles = new Set(files.filter(file => file.startsWith(`${ENGINE}/`) || file === "apps/desktop/src/cli.ts"));
  for (const [file, input] of Object.entries(result.metafile.inputs).sort(([a], [b]) => byteOrder(a, b))) {
    check(validPath(file) && !forbiddenPayloadPath(file) && !sourceTest(file) &&
      within(source, await realpath(path.join(source, file))), "source_path");
    inputs[file] = input;
    // Workspace package sources are retained by the dependency walker; the
    // existing fixed source/data slices still preserve their complete layout.
    if (!file.startsWith("packages/") && !ROOT_METADATA.includes(file) &&
      !SOURCE_SLICES.filter(slice => slice !== "apps/desktop/src")
        .some(slice => file === slice || file.startsWith(`${slice}/`))) sourceFiles.add(file);
    for (const edge of input.imports) {
      if (!edge.external || isBuiltin(edge.path) || edge.path.startsWith(".") || edge.path === "<runtime>") continue;
      const name = edge.path.split("/").slice(0, edge.path.startsWith("@") ? 2 : 1).join("/");
      check(/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name), "dependency_name");
      dependencyRoots.add(name);
    }
  }
  const pkg = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  for (const name of dependencyRoots)
    check(Object.hasOwn(pkg.dependencies ?? {}, name) ||
      (HARNESS_ROOTS.includes(name) && Object.hasOwn(pkg.devDependencies ?? {}, name)), "dependency_root");
  return { schema: "zeros.cloud-source-closure/v1", entryPoints,
    sourceFiles: [...sourceFiles].sort(byteOrder), dependencyRoots: [...dependencyRoots].sort(byteOrder), inputs };
}
