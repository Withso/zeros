import path from "node:path";
import { parse } from "parse5";
import { compile } from "tailwindcss";
import { DESIGN_TAILWIND_STYLESHEETS, DESIGN_TAILWIND_VERSION } from "./generated/tailwind-stylesheets";
import { elementRecords } from "./source";

// Compiled Tailwind style sources. A source names the application's Tailwind
// v4 entry stylesheet; Zeros compiles it with its own bundled Tailwind for the
// classes each frame uses. Imports resolve to CSS files inside the repository
// only, and @plugin/@config modules are replaced by empty ones: nothing from
// the repository executes.

export { DESIGN_TAILWIND_VERSION };
export const MAX_TAILWIND_IMPORTS = 32;
export const MAX_TAILWIND_CANDIDATES = 4096;

/** Reads a repository-relative POSIX file: CSS or a package manifest. */
export type TailwindFileReader = (file: string) => Promise<string | null>;

export interface DesignTailwindCompiler {
  build(candidates: readonly string[]): string;
  /** Repository stylesheets the entry imported, sorted: Tailwind loads
   * imports concurrently, so load order is not stable. */
  imports: string[];
  /** Imports that do not name a CSS file inside the repository. */
  skippedImports: string[];
  /** `@plugin` and `@config` directives that were not run. */
  skippedModules: string[];
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

async function firstCss(read: TailwindFileReader, file: string): Promise<string | null> {
  for (const candidate of file.endsWith(".css") ? [file] : [`${file}.css`, `${file}/index.css`]) {
    if (insideRepository(candidate) && (await read(candidate)) !== null) return candidate;
  }
  return null;
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
      if (target) return target.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return null;
}

/** Resolve a package stylesheet the way CSS tooling does: the nearest
 * node_modules, then `exports` (style or default), `style`, a CSS `main`, or
 * index.css. */
async function packageCss(read: TailwindFileReader, id: string, base: string): Promise<string | null> {
  const parts = id.split("/");
  const name = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const rest = parts.slice(id.startsWith("@") ? 2 : 1).join("/");
  if (!name || (id.startsWith("@") && parts.length < 2)) return null;
  for (let directory = base; ; directory = path.posix.dirname(directory)) {
    const at = directory === "." ? "" : directory;
    const packageDirectory = path.posix.join(at, "node_modules", name);
    const source = await read(`${packageDirectory}/package.json`);
    if (source !== null) {
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(source) as Record<string, unknown>;
      } catch {
        return null;
      }
      const subpath = rest ? `./${rest}` : ".";
      const main = typeof manifest.main === "string" && manifest.main.endsWith(".css") ? manifest.main : null;
      const target =
        exportsTarget(manifest.exports, subpath) ??
        (rest || (typeof manifest.style === "string" ? manifest.style : null) || main || "index.css");
      const file = path.posix.normalize(path.posix.join(packageDirectory, target));
      return file.startsWith(`${packageDirectory}/`) ? firstCss(read, file) : null;
    }
    if (!at) return null;
  }
}

async function resolveImport(read: TailwindFileReader, id: string, base: string): Promise<string | null> {
  if (!id || id.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(id)) return null;
  const relative = path.posix.normalize(path.posix.join(base, id));
  if (id.startsWith("./") || id.startsWith("../")) return firstCss(read, relative);
  // CSS tooling prefers a relative file, then a package.
  return (await firstCss(read, relative)) ?? packageCss(read, id, base);
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
 * compile from recorded contents without touching the disk. */
export async function compileDesignTailwind(
  entry: { file: string; content: string },
  read: TailwindFileReader,
): Promise<DesignTailwindCompiler> {
  const imports: string[] = [];
  const skippedImports: string[] = [];
  const skippedModules: string[] = [];
  const compiler = await compile(entry.content, {
    base: path.posix.dirname(entry.file),
    async loadStylesheet(id: string, base: string) {
      const own = bundled(id, base);
      if (own) return own;
      const file = await resolveImport(read, id, base);
      if (!file) {
        skippedImports.push(id);
        return { path: id, base, content: "" };
      }
      if (imports.length >= MAX_TAILWIND_IMPORTS) {
        throw new Error(`A Tailwind source may import at most ${MAX_TAILWIND_IMPORTS} stylesheets.`);
      }
      imports.push(file);
      return { path: file, base: path.posix.dirname(file), content: (await read(file)) ?? "" };
    },
    async loadModule(id: string, base: string, resourceHint: "plugin" | "config") {
      skippedModules.push(`@${resourceHint} ${id}`);
      // An empty plugin or config: the rest of the stylesheet still compiles.
      return { path: id, base, module: resourceHint === "config" ? {} : () => {} };
    },
  });
  const sorted = (values: string[]) => [...new Set(values)].sort();
  return {
    build: (candidates) => compiler.build([...candidates]),
    imports: sorted(imports),
    skippedImports: sorted(skippedImports),
    skippedModules: sorted(skippedModules),
  };
}
