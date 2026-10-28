import path from "node:path";
import type { DesignTailwindImportProblem, DesignTailwindSkippedImport, TailwindFileDiagnosis, TailwindFileReader } from "./style-tailwind";
import { compileSassInOwnedProcess } from "./sass-process";

// Compiled Sass style sources. A source names the application's Sass entry
// (.scss or .sass); Zeros compiles it with its own bundled Dart Sass. Every
// `@use`, `@forward` and `@import` resolves through one importer to files
// inside the repository: relative partials, then packages through the
// nearest node_modules (`pkg:` URLs, bare names and webpack's `~name`). Sass's
// own filesystem loading is never used, so nothing outside the checkout is
// read and no repository code runs. Sass loads on first use, so engines with
// no Sass source never pay its start-up cost.

export const MAX_SASS_FILES = 1_024;
const SCHEME = "zrepo:";

/** Sass's own modules, such as sass:math, need no importer. */
const BUILT_IN = /^sass:/;
const SASS_EXTENSIONS = [".scss", ".sass", ".css"] as const;

export interface DesignSassResult {
  css: string;
  version: string | null;
  /** Repository files the compile read, sorted. */
  files: string[];
}

export class DesignSassImportError extends Error {
  constructor(readonly skipped: DesignTailwindSkippedImport[], message: string) {
    super(message);
    this.name = "DesignSassImportError";
  }
}

function insideRepository(file: string): boolean {
  const top = file.split("/")[0];
  return !!file && file !== ".." && !file.startsWith("../") && !path.posix.isAbsolute(file) && top !== ".git" && top !== ".zeros";
}

/** The files a Sass load may name: the partial and index rules. */
function sassCandidates(file: string, fromImport: boolean): string[] {
  const directory = path.posix.dirname(file);
  const base = path.posix.basename(file);
  const extension = path.posix.extname(base);
  const join = (name: string) => (directory === "." ? name : `${directory}/${name}`);
  if ((SASS_EXTENSIONS as readonly string[]).includes(extension)) {
    return [file, join(`_${base}`)];
  }
  const named = (stem: string) => [
    ...(fromImport ? [`${stem}.import.scss`, `${stem}.import.sass`] : []),
    `${stem}.scss`, `${stem}.sass`, `${stem}.css`,
  ];
  return [
    ...named(file),
    ...named(join(`_${base}`)),
    ...["index", "_index"].flatMap((index) => named(`${file}/${index}`)),
  ];
}

/** The Sass entry a package names: `exports` with the sass, style or default
 * condition, then `sass`, `style`, a stylesheet `main`, or an index file. */
function packageEntry(manifest: Record<string, unknown>, subpath: string): string | null {
  let visited = 0;
  const conditional = (value: unknown, depth = 0): string | null => {
    if (++visited > 4096 || depth > 32) throw new Error("Sass package manifest budget exceeded");
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const target = conditional(entry, depth + 1);
        if (target) return target;
      }
      return null;
    }
    if (value && typeof value === "object") {
      const conditions = value as Record<string, unknown>;
      return conditional(conditions.sass, depth + 1) ?? conditional(conditions.style, depth + 1) ?? conditional(conditions.default, depth + 1);
    }
    return null;
  };
  const exports = manifest.exports;
  if (exports !== undefined && exports !== null) {
    const map = typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))
      ? (exports as Record<string, unknown>)
      : { ".": exports };
    const target = conditional(map[subpath]);
    if (target && /\.(?:scss|sass|css)$/.test(target)) return target;
  }
  if (subpath !== ".") return null;
  for (const field of ["sass", "style", "main"] as const) {
    const value = manifest[field];
    if (typeof value === "string" && /\.(?:scss|sass|css)$/.test(value)) return value;
  }
  return null;
}

export interface DesignSassOptions {
  signal?: AbortSignal;
  /** May lower the hard 10-second execution ceiling. */
  executionTimeoutMs?: number;
  /** Explains a manifest the reader refused (a link outside the checkout). */
  diagnose?: TailwindFileDiagnosis;
  /** Whether the checkout has installed dependencies at all, so a missing
   * bare name reads as "not installed" rather than a missing partial. */
  installed?: () => Promise<boolean>;
}

type Resolution = { file: string } | { problem: DesignTailwindImportProblem };

/** Compile one Sass entry. `read` supplies every repository file (Sass
 * sources and package manifests). */
export async function compileDesignSass(
  entry: { file: string; content: string },
  readSource: TailwindFileReader,
  options: DesignSassOptions = {},
): Promise<DesignSassResult> {
  const { diagnose, installed } = options;
  if (entry.file.length > 4096 || !insideRepository(entry.file) || Buffer.byteLength(entry.content) > 2 * 1024 * 1024)
    throw new Error("Sass source budget exceeded");
  const cache = new Map<string, Promise<string | null>>();
  let inputBytes = Buffer.byteLength(entry.content);
  const read: TailwindFileReader = file => {
    if (options.signal?.aborted) return Promise.reject(new Error("Sass compilation cancelled"));
    if (file.length > 4096 || !insideRepository(file)) return Promise.resolve(null);
    const existing = cache.get(file);
    if (existing) return existing;
    if (cache.size >= 16_384) return Promise.reject(new Error("Sass import lookup budget exceeded"));
    const pending = readSource(file).then(content => {
      if (content !== null) {
        const bytes = Buffer.byteLength(content);
        inputBytes += bytes;
        if (bytes > 2 * 1024 * 1024 || inputBytes > 16 * 1024 * 1024) throw new Error("Sass input byte budget exceeded");
      }
      return content;
    });
    cache.set(file, pending);
    return pending;
  };
  const loaded = new Set<string>([entry.file]);
  const track = (file: string) => {
    loaded.add(file);
    if (loaded.size > MAX_SASS_FILES) throw new Error("Sass import file budget exceeded");
  };
  const skipped = new Map<string, DesignTailwindImportProblem>();
  const toUrl = (file: string) => new URL(`${SCHEME}/${file.split("/").map(encodeURIComponent).join("/")}`);
  const fromUrl = (url: URL | string) => decodeURIComponent(String(url).slice(`${SCHEME}/`.length));

  const firstFile = async (file: string, fromImport: boolean): Promise<string | null> => {
    for (const candidate of sassCandidates(file, fromImport)) {
      if (insideRepository(candidate) && (await read(candidate)) !== null) return candidate;
    }
    return null;
  };

  const resolvePackage = async (specifier: string, containing: string, fromImport: boolean): Promise<Resolution> => {
    const parts = specifier.split("/");
    const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const rest = parts.slice(specifier.startsWith("@") ? 2 : 1).join("/");
    if (!name || (specifier.startsWith("@") && parts.length < 2)) return { problem: "missing" };
    for (let directory = path.posix.dirname(containing); ; directory = path.posix.dirname(directory)) {
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
        const declared = packageEntry(manifest, rest ? `./${rest}` : ".");
        const target = path.posix.normalize(path.posix.join(packageDirectory, declared ?? (rest || "index")));
        if (!target.startsWith(`${packageDirectory}/`)) return { problem: "outside" };
        const file = await firstFile(target, fromImport);
        return file ? { file } : { problem: declared || rest ? "missing" : "not-css" };
      }
      if (diagnose && (await diagnose(manifestFile)) === "outside") return { problem: "outside" };
      if (!at) {
        // No package: an uninstalled dependency, or a partial that is missing.
        return { problem: installed && !(await installed()) ? "not-installed" : "missing" };
      }
    }
  };

  const importer = {
    nonCanonicalScheme: "pkg",
    async canonicalize(url: string, context: { fromImport: boolean; containingUrl: URL | null }): Promise<URL | null> {
      if (BUILT_IN.test(url)) return null;
      // A relative load, already resolved against its stylesheet.
      if (url.startsWith(SCHEME)) {
        const file = path.posix.normalize(fromUrl(url));
        const found = insideRepository(file) ? await firstFile(file, context.fromImport) : null;
        if (found) track(found);
        return found ? toUrl(found) : null;
      }
      const containing = context.containingUrl && String(context.containingUrl).startsWith(SCHEME)
        ? fromUrl(context.containingUrl)
        : entry.file;
      const problem = (id: string, reason: DesignTailwindImportProblem): never => {
        skipped.set(id, reason);
        throw new Error(`Could not import ${id}.`);
      };
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith("pkg:")) return problem(url, "remote");
      if (url.startsWith("/")) return problem(url, "absolute");
      if (url.startsWith("@/") || url.startsWith("~/") || url.startsWith("#")) return problem(url, "alias");
      // A relative partial the stylesheet's own lookup did not find.
      if (url.startsWith("./") || url.startsWith("../")) return problem(url, "missing");
      // A bare name the relative lookup did not find: a package.
      const specifier = url.startsWith("pkg:") ? url.slice(4) : url.startsWith("~") ? url.slice(1) : url;
      const resolved = await resolvePackage(specifier, containing, context.fromImport);
      if ("problem" in resolved) return problem(url, resolved.problem);
      if (loaded.size >= MAX_SASS_FILES) throw new Error(`A Sass source may read at most ${MAX_SASS_FILES} files.`);
      track(resolved.file);
      return toUrl(resolved.file);
    },
    async load(canonicalUrl: URL) {
      const file = fromUrl(canonicalUrl);
      const contents = await read(file);
      if (contents === null) return null;
      const extension = path.posix.extname(file);
      return { contents, syntax: extension === ".sass" ? "indented" as const : extension === ".css" ? "css" as const : "scss" as const };
    },
  };

  try {
    const result = await compileSassInOwnedProcess({
      content: entry.content,
      url: toUrl(entry.file).href,
      syntax: entry.file.endsWith(".sass") ? "indented" : "scss",
    }, importer, options);
    return { css: result.css, version: result.version, files: [...loaded].sort() };
  } catch (error) {
    if (skipped.size > 0) {
      throw new DesignSassImportError(
        [...skipped].map(([id, problem]) => ({ id, problem })).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}
