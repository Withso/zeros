import path from "node:path";
import { parse } from "parse5";
import { compile } from "tailwindcss";
import { DESIGN_TAILWIND_PLUGIN_VERSIONS, DESIGN_TAILWIND_STYLESHEETS, DESIGN_TAILWIND_VERSION } from "./generated/tailwind-stylesheets";
import { elementRecords } from "./source";

// Compiled Tailwind style sources. A source names the application's Tailwind
// v4 entry stylesheet; Zeros compiles it with its own bundled Tailwind for the
// classes each frame uses. Imports resolve to CSS files inside the repository
// only. `@plugin` names one of the widely used official plugins Zeros ships
// (typography, forms, animate) runs Zeros' own copy; every other @plugin and
// @config gets an empty module: nothing from the repository executes.

export { DESIGN_TAILWIND_PLUGIN_VERSIONS, DESIGN_TAILWIND_VERSION };

/** Plugins Zeros bundles, loaded on first use. Their versions may differ from
 * the application's; the source status names the bundled ones. */
const BUNDLED_PLUGINS: Readonly<Record<string, () => Promise<unknown>>> = {
  "@tailwindcss/typography": () => import("@tailwindcss/typography"),
  "@tailwindcss/forms": () => import("@tailwindcss/forms"),
  "tailwindcss-animate": () => import("tailwindcss-animate"),
};

async function bundledPlugin(id: string): Promise<unknown | null> {
  const load = Object.hasOwn(BUNDLED_PLUGINS, id) ? BUNDLED_PLUGINS[id] : undefined;
  if (!load) return null;
  const loaded = (await load()) as { default?: unknown };
  return loaded.default ?? loaded;
}
export const MAX_TAILWIND_IMPORTS = 1_024;
export const MAX_TAILWIND_CANDIDATES = 4096;

/** Reads a repository-relative POSIX file: CSS or a package manifest. */
export type TailwindFileReader = (file: string) => Promise<string | null>;

/** Why the reader returned null for a repository file. Consulted only to
 * explain a skipped import, never to read anything. */
export type TailwindFileDiagnosis = (file: string) => Promise<"missing" | "outside" | "link" | "too-large" | "unreadable">;

/** Why an `@import` was not followed. */
export type DesignTailwindImportProblem =
  /** A package whose manifest is not in any node_modules: not installed yet. */
  | "not-installed"
  /** A link whose real location is outside the checkout. */
  | "outside"
  /** A symbolic link in the file's own name, which the reader never follows. */
  | "link"
  /** A relative file, or a package's own stylesheet, that does not exist. */
  | "missing"
  | "absolute"
  | "remote"
  /** A bundler or tsconfig path alias such as `@/…`, `~/…` or `#…`. */
  | "alias"
  /** A package that does not name a stylesheet. */
  | "not-css"
  | "too-large"
  | "unreadable";

export interface DesignTailwindSkippedImport {
  id: string;
  problem: DesignTailwindImportProblem;
}

export interface DesignTailwindCompiler {
  build(candidates: readonly string[]): string;
  /** Repository stylesheets the entry imported, sorted: Tailwind loads
   * imports concurrently, so load order is not stable. */
  imports: string[];
  /** Imports that were not followed, with why, sorted by id. */
  skippedImports: DesignTailwindSkippedImport[];
  /** `@plugin` and `@config` directives that were not run. */
  skippedModules: string[];
  /** `@plugin` directives Zeros ran with its own bundled copy. */
  bundledModules: string[];
}

const BUNDLED_BASE = "\0tailwindcss";

/** Classes and custom properties a frame uses. Custom properties count so
 * Tailwind emits a theme variable that frame CSS reads with var(). */
export function designTailwindCandidates(html: string, stylesheetVariables: readonly string[] = []): string[] {
  const candidates = new Set<string>(stylesheetVariables);
  for (const { element } of elementRecords(parse(html))) {
    const value = element.attrs.find((attribute) => attribute.name === "class")?.value;
    if (value) for (const token of value.split(/\s+/)) if (token) candidates.add(token);
  }
  for (const variable of designTailwindVariables(html)) candidates.add(variable);
  return [...candidates].sort().slice(0, MAX_TAILWIND_CANDIDATES);
}

/** Prepared linked stylesheets cache these alongside their CSS so every
 * frame need not scan the whole shared stylesheet during identity reads. */
export function designTailwindVariables(css: string): string[] {
  return [...new Set([...css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => match[1]!))]
    .sort().slice(0, MAX_TAILWIND_CANDIDATES);
}

function insideRepository(file: string): boolean {
  const top = file.split("/")[0];
  return !!file && file !== ".." && !file.startsWith("../") && !path.posix.isAbsolute(file) && top !== ".git" && top !== ".zeros";
}

type Resolution = { file: string } | { problem: DesignTailwindImportProblem };

function cssCandidates(file: string): string[] {
  return file.endsWith(".css") ? [file] : [`${file}.css`, `${file}/index.css`];
}

async function firstCss(read: TailwindFileReader, file: string): Promise<string | null> {
  for (const candidate of cssCandidates(file)) {
    if (insideRepository(candidate) && (await read(candidate)) !== null) return candidate;
  }
  return null;
}

/** firstCss, explaining a miss by its most specific candidate. */
async function resolveCss(read: TailwindFileReader, file: string, diagnose?: TailwindFileDiagnosis): Promise<Resolution> {
  const found = await firstCss(read, file);
  if (found) return { file: found };
  const primary = cssCandidates(file)[0]!;
  if (!insideRepository(primary)) return { problem: "outside" };
  return { problem: diagnose ? await diagnose(primary) : "missing" };
}

/** The CSS target of a package `exports` entry: `style`, then `default`. */
function conditionalTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = conditionalTarget(entry);
      if (target) return target;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const conditions = value as Record<string, unknown>;
    return conditionalTarget(conditions.style) ?? conditionalTarget(conditions.default);
  }
  return null;
}

function exportsTarget(exports: unknown, subpath: string): string | null {
  if (exports === undefined || exports === null) return null;
  const map =
    typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))
      ? (exports as Record<string, unknown>)
      : { ".": exports };
  if (map[subpath] !== undefined) return conditionalTarget(map[subpath]);
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
      const target = conditionalTarget(value);
      // Export patterns substitute every star; a callback keeps `$` sequences
      // in the matched subpath literal rather than replacement-string syntax.
      if (target) return target.replaceAll("*", () => subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return null;
}

/** Resolve a package stylesheet the way CSS tooling does: the nearest
 * node_modules, then `exports` (style or default), `style`, a CSS `main`, or
 * index.css. */
async function packageCss(
  read: TailwindFileReader,
  id: string,
  base: string,
  diagnose?: TailwindFileDiagnosis,
): Promise<Resolution> {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const rest = parts.slice(id.startsWith("@") ? 2 : 1).join("/");
  if (!name || (id.startsWith("@") && parts.length < 2)) return { problem: "not-installed" };
  for (let directory = base; ; directory = path.posix.dirname(directory)) {
    const at = directory === "." ? "" : directory;
    const packageDirectory = path.posix.join(at, "node_modules", name);
    const manifestFile = `${packageDirectory}/package.json`;
    const source = await read(manifestFile);
    if (source !== null) {
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(source) as Record<string, unknown>;
      } catch {
        return { problem: "unreadable" };
      }
      const subpath = rest ? `./${rest}` : ".";
      const main = typeof manifest.main === "string" && manifest.main.endsWith(".css") ? manifest.main : null;
      const exported = exportsTarget(manifest.exports, subpath);
      const declared = exported ?? (rest || (typeof manifest.style === "string" ? manifest.style : null) || main);
      const file = path.posix.normalize(path.posix.join(packageDirectory, declared ?? "index.css"));
      if (!file.startsWith(`${packageDirectory}/`)) return { problem: "outside" };
      const resolved = await resolveCss(read, file, diagnose);
      if ("file" in resolved || resolved.problem !== "missing") return resolved;
      // A package that names no stylesheet, or names a script, is not CSS;
      // one that names a stylesheet it lacks is an incomplete install.
      return { problem: declared === null || (exported !== null && !/\.css$/i.test(exported)) ? "not-css" : "missing" };
    }
    // A link to a package stored outside the checkout is present but refused.
    if (diagnose && (await diagnose(manifestFile)) === "outside") return { problem: "outside" };
    if (!at) return { problem: "not-installed" };
  }
}

async function resolveImport(
  read: TailwindFileReader,
  id: string,
  base: string,
  diagnose?: TailwindFileDiagnosis,
): Promise<Resolution> {
  if (!id) return { problem: "missing" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(id) || id.startsWith("//")) return { problem: "remote" };
  if (id.startsWith("/")) return { problem: "absolute" };
  if (id.startsWith("@/") || id.startsWith("~/") || id.startsWith("#")) return { problem: "alias" };
  // `~package` is the webpack spelling of a package import.
  const specifier = id.startsWith("~") ? id.slice(1) : id;
  const relative = path.posix.normalize(path.posix.join(base, specifier));
  if (specifier.startsWith("./") || specifier.startsWith("../")) return resolveCss(read, relative, diagnose);
  // CSS tooling prefers a relative file, then a package.
  const local = await firstCss(read, relative);
  return local ? { file: local } : packageCss(read, specifier, base, diagnose);
}

function bundled(id: string, base: string): { path: string; base: string; content: string } | null {
  const name =
    id === "tailwindcss"
      ? "index.css"
      : id.startsWith("tailwindcss/")
        ? id.slice("tailwindcss/".length)
        : base === BUNDLED_BASE
          ? id.replace(/^\.\//, "")
          : null;
  if (name === null) return null;
  const file = name.endsWith(".css") ? name : `${name}.css`;
  const content = DESIGN_TAILWIND_STYLESHEETS[file];
  return content === undefined ? null : { path: `tailwindcss/${file}`, base: BUNDLED_BASE, content };
}

/** Compile one entry. `read` supplies every file, so a caller can replay a
 * compile from recorded contents without touching the disk; `diagnose` only
 * explains imports that could not be read. */
export async function compileDesignTailwind(
  entry: { file: string; content: string },
  read: TailwindFileReader,
  diagnose?: TailwindFileDiagnosis,
): Promise<DesignTailwindCompiler> {
  const imports: string[] = [];
  const skippedImports = new Map<string, DesignTailwindImportProblem>();
  const skippedModules: string[] = [];
  const bundledModules: string[] = [];
  const compiler = await compile(entry.content, {
    base: path.posix.dirname(entry.file),
    async loadStylesheet(id: string, base: string) {
      const own = bundled(id, base);
      if (own) return own;
      const resolution = await resolveImport(read, id, base, diagnose);
      if (!("file" in resolution)) {
        if (!skippedImports.has(id)) skippedImports.set(id, resolution.problem);
        return { path: id, base, content: "" };
      }
      const file = resolution.file;
      if (imports.length >= MAX_TAILWIND_IMPORTS) {
        throw new Error(`A Tailwind source may import at most ${MAX_TAILWIND_IMPORTS} stylesheets.`);
      }
      imports.push(file);
      return { path: file, base: path.posix.dirname(file), content: (await read(file)) ?? "" };
    },
    async loadModule(id: string, base: string, resourceHint: "plugin" | "config") {
      const plugin = resourceHint === "plugin" ? await bundledPlugin(id) : null;
      if (plugin) {
        bundledModules.push(`@plugin ${id}`);
        return { path: id, base, module: plugin as never };
      }
      skippedModules.push(`@${resourceHint} ${id}`);
      // An empty plugin or config: the rest of the stylesheet still compiles.
      return { path: id, base, module: resourceHint === "config" ? {} : () => {} };
    },
  });
  const sorted = (values: string[]) => [...new Set(values)].sort();
  return {
    build: (candidates) => compiler.build([...candidates]),
    imports: sorted(imports),
    skippedImports: [...skippedImports]
      .map(([id, problem]) => ({ id, problem }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    skippedModules: sorted(skippedModules),
    bundledModules: sorted(bundledModules),
  };
}
