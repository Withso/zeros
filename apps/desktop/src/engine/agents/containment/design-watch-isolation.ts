import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const NODE_DESIGN_WATCH_GUARD_FILENAME = "zeros-design-watch-guard.cjs";
export const DESIGN_WATCH_IGNORE_FILENAME = "zeros-design-watch.ignore";
export const DESIGN_WATCH_ROOTS_FILENAME = "zeros-design-watch-roots.json";

export interface DesignWatchIsolationArtifacts {
  readonly nodeGuardPath: string;
  readonly ignoreFilePath: string;
  readonly rootsFilePath: string;
}

function pathValue(value: string | Buffer | URL): string {
  if (value instanceof URL) return fileURLToPath(value);
  return Buffer.isBuffer(value) ? value.toString() : value;
}

function canonicalPath(value: string | Buffer | URL): string {
  const resolved = path.resolve(pathValue(value));
  let cursor = resolved;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(cursor), ...suffix);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function pathInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(
    comparisonPath(root),
    comparisonPath(candidate),
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function gitignorePatternSegment(value: string): string {
  // Watchexec's explicit ignore files use gitignore-style syntax. Escape every
  // character that can acquire pattern meaning (and spaces, including trailing
  // ones) so a user-selected Design name remains a literal filesystem path.
  return value.replace(/[\\*?[\]#! ]/g, "\\$&");
}

/** Render project-origin-anchored ignores for native watcher supervisors that
 * support an explicit ignore file (currently Watchexec). A protected root is
 * included only when an exact workspace owner was supplied; falling back to a
 * broad recursive basename glob could hide unrelated application code.
 */
export function designWatchIgnoreSource(
  protectedRoots: readonly string[],
  workspaceRoots: readonly string[],
): string {
  const owners = [...new Set(workspaceRoots.map((root) => path.resolve(root)))];
  const lines = new Set<string>();
  for (const input of protectedRoots) {
    const protectedRoot = path.resolve(input);
    const owner = owners
      .filter((candidate) => pathInsideOrEqual(protectedRoot, candidate))
      .sort((left, right) => right.length - left.length)[0];
    if (!owner) continue;
    const relative = path.relative(owner, protectedRoot);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      continue;
    }
    const literal = relative
      .split(path.sep)
      .map(gitignorePatternSegment)
      .join("/");
    lines.add(`/${literal}`);
    lines.add(`/${literal}/**`);
  }
  return lines.size > 0 ? `${[...lines].join("\n")}\n` : "";
}

export function designWatchRootsManifestSource(
  protectedRoots: readonly string[],
): string {
  return `${JSON.stringify({
    version: 1,
    protectedRoots: [
      ...new Set(protectedRoots.map((root) => path.resolve(root))),
    ].sort((left, right) => left.localeCompare(right)),
  })}\n`;
}

/** Decide whether one fs watcher notification belongs to protected Design
 * territory. A missing filename is suppressible only when the watched target
 * itself is protected; hiding an ambiguous parent event would also hide real
 * code changes. */
export function shouldSuppressDesignWatchEvent(
  watched: string | Buffer | URL,
  filename: string | Buffer | null | undefined,
  protectedRoots: readonly string[],
): boolean {
  const watchedPath = canonicalPath(watched);
  const roots = protectedRoots.map(canonicalPath);
  if (roots.some((root) => pathInsideOrEqual(watchedPath, root))) return true;
  if (filename == null) return false;
  const filenamePath = pathValue(filename);
  const candidate = canonicalPath(
    path.isAbsolute(filenamePath)
      ? filenamePath
      : path.resolve(watchedPath, filenamePath),
  );
  return roots.some((root) => pathInsideOrEqual(candidate, root));
}

/** Render a dependency-free CommonJS preload. Repository commands inherit it
 * through NODE_OPTIONS, so Vite/chokidar/watchpack and other Node watcher
 * stacks never receive Design events while ordinary reads remain untouched. */
export function nodeDesignWatchGuardSource(
  protectedRoots: readonly string[],
  workspaceRoots: readonly string[] = [],
): string {
  return `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const Module = require("node:module");
const syncBuiltinESMExports = Module && Module.syncBuiltinESMExports;
const installation = Symbol.for("zeros.design-watch-guard.v5");
const state = globalThis[installation] || (globalThis[installation] = {
  installed: false,
  roots: [],
  workspaces: [],
  rootIdentities: new Set(),
  rootLocations: new Map(),
});
const foldCase = process.platform === "darwin" || process.platform === "win32";
const asPath = (value) => value instanceof URL
  ? fileURLToPath(value)
  : Buffer.isBuffer(value) ? value.toString() : String(value);
const canonical = (value) => {
  const resolved = path.resolve(asPath(value));
  let cursor = resolved;
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cursor), ...suffix); } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
};
const comparison = (value) => {
  const normalized = path.normalize(value);
  return foldCase ? normalized.toLocaleLowerCase("en-US") : normalized;
};
const inside = (candidate, root) => {
  const relative = path.relative(comparison(root), comparison(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
const identity = (value) => {
  try {
    const details = fs.statSync(value, { bigint: true });
    return details.isDirectory() ? String(details.dev) + ":" + String(details.ino) : null;
  } catch { return null; }
};
for (const value of ${JSON.stringify(protectedRoots)}) {
  const root = canonical(value);
  if (!state.roots.some((known) => comparison(known) === comparison(root))) {
    state.roots.push(root);
  }
  const rootIdentity = identity(root);
  if (rootIdentity) {
    state.rootIdentities.add(rootIdentity);
    if (!state.rootLocations.has(rootIdentity)) {
      state.rootLocations.set(rootIdentity, root);
    }
  }
}
for (const value of ${JSON.stringify(workspaceRoots)}) {
  const workspace = canonical(value);
  if (!state.workspaces.some((known) => comparison(known) === comparison(workspace))) {
    state.workspaces.push(workspace);
  }
}
if (!state.installed) {
  state.installed = true;
  const roots = state.roots;
  const workspaces = state.workspaces;
  const rootIdentities = state.rootIdentities;
  const rootLocations = state.rootLocations;
  const rememberMovedRoot = (candidate) => {
    if (rootIdentities.size === 0) return false;
    const owner = workspaces
      .filter((workspace) => inside(candidate, workspace))
      .sort((left, right) => right.length - left.length)[0];
    if (!owner) return false;
    let cursor = candidate;
    for (;;) {
      const candidateIdentity = identity(cursor);
      if (candidateIdentity && rootIdentities.has(candidateIdentity)) {
        const previous = rootLocations.get(candidateIdentity);
        if (previous && comparison(previous) !== comparison(cursor)) {
          for (let index = roots.length - 1; index >= 0; index -= 1) {
            if (comparison(roots[index]) === comparison(previous)) {
              roots.splice(index, 1);
            }
          }
        }
        if (!roots.some((known) => comparison(known) === comparison(cursor))) {
          roots.push(cursor);
        }
        rootLocations.set(candidateIdentity, cursor);
        return true;
      }
      if (comparison(cursor) === comparison(owner)) return false;
      const parent = path.dirname(cursor);
      if (parent === cursor || !inside(parent, owner)) return false;
      cursor = parent;
    }
  };
  const suppress = (watched, filename) => {
    const watchedPath = canonical(watched);
    if (roots.some((root) => inside(watchedPath, root))) return true;
    if (rememberMovedRoot(watchedPath)) return true;
    if (filename == null) return false;
    const name = asPath(filename);
    const candidate = canonical(path.isAbsolute(name) ? name : path.resolve(watchedPath, name));
    return roots.some((root) => inside(candidate, root)) || rememberMovedRoot(candidate);
  };

  const originalWatch = fs.watch;
  fs.watch = function guardedWatch(filename, options, listener) {
    let actualOptions = options;
    let actualListener = listener;
    if (typeof options === "function") {
      actualListener = options;
      actualOptions = undefined;
    }
    const watcher = actualOptions === undefined
      ? originalWatch.call(fs, filename)
      : originalWatch.call(fs, filename, actualOptions);
    const originalEmit = watcher.emit;
    watcher.emit = function guardedEmit(eventName, ...args) {
      if (eventName === "change" && suppress(filename, args[1])) return false;
      return Reflect.apply(originalEmit, this, [eventName, ...args]);
    };
    if (typeof actualListener === "function") watcher.on("change", actualListener);
    return watcher;
  };

  const watchFileWrappers = new WeakMap();
  const originalWatchFile = fs.watchFile;
  const originalUnwatchFile = fs.unwatchFile;
  fs.watchFile = function guardedWatchFile(filename, options, listener) {
    let actualOptions = options;
    let actualListener = listener;
    if (typeof options === "function") {
      actualListener = options;
      actualOptions = undefined;
    }
    if (typeof actualListener !== "function" || !suppress(filename, null)) {
      return actualOptions === undefined
        ? originalWatchFile.call(fs, filename, actualListener)
        : originalWatchFile.call(fs, filename, actualOptions, actualListener);
    }
    const wrapped = () => {};
    let byPath = watchFileWrappers.get(actualListener);
    if (!byPath) {
      byPath = new Map();
      watchFileWrappers.set(actualListener, byPath);
    }
    byPath.set(comparison(canonical(filename)), wrapped);
    return actualOptions === undefined
      ? originalWatchFile.call(fs, filename, wrapped)
      : originalWatchFile.call(fs, filename, actualOptions, wrapped);
  };
  fs.unwatchFile = function guardedUnwatchFile(filename, listener) {
    if (typeof listener !== "function") return originalUnwatchFile.call(fs, filename);
    const byPath = watchFileWrappers.get(listener);
    const key = comparison(canonical(filename));
    const wrapped = byPath && byPath.get(key);
    if (!wrapped) return originalUnwatchFile.call(fs, filename, listener);
    byPath.delete(key);
    if (byPath.size === 0) watchFileWrappers.delete(listener);
    return originalUnwatchFile.call(fs, filename, wrapped);
  };

  if (fs.promises && typeof fs.promises.watch === "function") {
    const originalPromisesWatch = fs.promises.watch.bind(fs.promises);
    fs.promises.watch = function guardedPromisesWatch(filename, options) {
      const iterator = originalPromisesWatch(filename, options);
      const originalNext = iterator.next.bind(iterator);
      let proxy;
      const filteredNext = async () => {
        for (;;) {
          const result = await originalNext();
          if (result.done || !suppress(filename, result.value && result.value.filename)) {
            return result;
          }
        }
      };
      proxy = new Proxy(iterator, {
        get(target, property) {
          if (property === "next") return filteredNext;
          if (property === Symbol.asyncIterator) return () => proxy;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return proxy;
    };
  }

  // Chokidar 3 (bundled by Vite 6) uses the native fsevents package on macOS
  // instead of node:fs. NODE_OPTIONS preloads run before the CLI entrypoint,
  // so wrapping Module._load here catches both ordinary require() and the
  // createRequire() call embedded in Vite's ESM bundle. Keep every other
  // property untouched; chokidar still needs getInfo() to classify events.
  const originalModuleLoad = Module && Module._load;
  const fseventsWrappers = new WeakMap();
  const isFseventsRequest = (request) =>
    request === "fsevents" ||
    /(?:^|[\\\\/])fsevents(?:[\\\\/]|$)/.test(String(request));
  const wrapFsevents = (loaded) => {
    if (
      (loaded === null || (typeof loaded !== "object" && typeof loaded !== "function")) ||
      typeof loaded.watch !== "function"
    ) return loaded;
    const cached = fseventsWrappers.get(loaded);
    if (cached) return cached;
    const descriptors = Object.getOwnPropertyDescriptors(loaded);
    const watchDescriptor = descriptors.watch;
    delete descriptors.watch;
    const wrapped = Object.create(Object.getPrototypeOf(loaded));
    Object.defineProperties(wrapped, descriptors);
    Object.defineProperty(wrapped, "watch", {
      configurable: false,
      enumerable: watchDescriptor ? watchDescriptor.enumerable : true,
      writable: false,
      value(watched, listener, ...args) {
        if (typeof listener !== "function") {
          return Reflect.apply(loaded.watch, loaded, [watched, listener, ...args]);
        }
        const guardedListener = function guardedFsevent(eventPath, ...eventArgs) {
          if (suppress(watched, eventPath)) return;
          return Reflect.apply(listener, this, [eventPath, ...eventArgs]);
        };
        return Reflect.apply(loaded.watch, loaded, [watched, guardedListener, ...args]);
      },
    });
    fseventsWrappers.set(loaded, wrapped);
    return wrapped;
  };
  if (typeof originalModuleLoad === "function") {
    Module._load = function guardedModuleLoad(request, parent, isMain) {
      const loaded = Reflect.apply(originalModuleLoad, this, [request, parent, isMain]);
      return isFseventsRequest(request) ? wrapFsevents(loaded) : loaded;
    };
  }
  if (typeof syncBuiltinESMExports === "function") syncBuiltinESMExports();
}
`;
}

export function nodeDesignWatchGuardPath(toolsRoot: string): string {
  return path.join(toolsRoot, NODE_DESIGN_WATCH_GUARD_FILENAME);
}

export function designWatchIsolationArtifacts(
  toolsRoot: string,
): DesignWatchIsolationArtifacts {
  return {
    nodeGuardPath: nodeDesignWatchGuardPath(toolsRoot),
    ignoreFilePath: path.join(toolsRoot, DESIGN_WATCH_IGNORE_FILENAME),
    rootsFilePath: path.join(toolsRoot, DESIGN_WATCH_ROOTS_FILENAME),
  };
}

async function canonicalPaths(values: readonly string[]): Promise<string[]> {
  return [
    ...new Set(
      await Promise.all(
        values.map(async (value) => {
          try {
            return await realpath(value);
          } catch {
            return path.resolve(value);
          }
        }),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

async function writeImmutableArtifact(
  target: string,
  source: string,
  adoptExisting: boolean,
): Promise<void> {
  try {
    await writeFile(target, source, {
      encoding: "utf8",
      mode: 0o444,
      flag: "wx",
    });
  } catch (error) {
    if (!adoptExisting || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await readFile(target, "utf8");
    if (existing !== source) {
      throw new Error(
        "Design watcher isolation artifact failed integrity check",
      );
    }
  }
  await chmod(target, 0o444);
}

function artifactSources(
  protectedRoots: readonly string[],
  workspaceRoots: readonly string[],
): {
  readonly guard: string;
  readonly ignore: string;
  readonly roots: string;
} {
  return {
    guard: nodeDesignWatchGuardSource(protectedRoots, workspaceRoots),
    ignore: designWatchIgnoreSource(protectedRoots, workspaceRoots),
    roots: designWatchRootsManifestSource(protectedRoots),
  };
}

async function writeDesignWatchIsolationArtifacts(
  toolsRoot: string,
  sources: ReturnType<typeof artifactSources>,
  adoptExisting: boolean,
): Promise<DesignWatchIsolationArtifacts> {
  const artifacts = designWatchIsolationArtifacts(toolsRoot);
  await Promise.all([
    writeImmutableArtifact(
      artifacts.nodeGuardPath,
      sources.guard,
      adoptExisting,
    ),
    writeImmutableArtifact(
      artifacts.ignoreFilePath,
      sources.ignore,
      adoptExisting,
    ),
    writeImmutableArtifact(
      artifacts.rootsFilePath,
      sources.roots,
      adoptExisting,
    ),
  ]);
  return artifacts;
}

/** Prepare the complete watcher-isolation contract inside one immutable ZSR
 * generation. The JSON manifest is the exact-path integration point for custom
 * runtimes; the ignore file is consumed automatically by Watchexec; and the
 * preload filters Node watcher APIs. */
export async function prepareDesignWatchIsolation(
  toolsRoot: string,
  protectedRoots: readonly string[],
  workspaceRoots: readonly string[],
): Promise<DesignWatchIsolationArtifacts | null> {
  if (protectedRoots.length === 0) return null;
  const [canonicalRoots, canonicalWorkspaces] = await Promise.all([
    canonicalPaths(protectedRoots),
    canonicalPaths(workspaceRoots),
  ]);
  return writeDesignWatchIsolationArtifacts(
    toolsRoot,
    artifactSources(canonicalRoots, canonicalWorkspaces),
    false,
  );
}

export async function prepareNodeDesignWatchGuard(
  toolsRoot: string,
  protectedRoots: readonly string[],
): Promise<string | null> {
  return (
    (await prepareDesignWatchIsolation(toolsRoot, protectedRoots, []))
      ?.nodeGuardPath ?? null
  );
}

/** Prepare content-addressed watcher artifacts for human terminals. Terminals
 * remain outside ZSR and keep their normal write authority. Content addressing
 * makes preparation one-time per exact root/owner set while allowing concurrent
 * starts to share all three immutable files. */
export async function prepareReusableDesignWatchIsolation(
  guardsRoot: string,
  protectedRoots: readonly string[],
  workspaceRoots: readonly string[],
): Promise<DesignWatchIsolationArtifacts | null> {
  if (protectedRoots.length === 0) return null;
  const [canonicalRoots, canonicalWorkspaces] = await Promise.all([
    canonicalPaths(protectedRoots),
    canonicalPaths(workspaceRoots),
  ]);
  const sources = artifactSources(canonicalRoots, canonicalWorkspaces);
  const fingerprint = createHash("sha256")
    .update(sources.guard)
    .update("\0")
    .update(sources.ignore)
    .update("\0")
    .update(sources.roots)
    .digest("hex")
    .slice(0, 32);
  const toolsRoot = path.join(guardsRoot, fingerprint);
  await mkdir(toolsRoot, { recursive: true, mode: 0o700 });
  return writeDesignWatchIsolationArtifacts(toolsRoot, sources, true);
}

/** Compatibility helper for focused callers that need only the Node preload. */
export async function prepareReusableNodeDesignWatchGuard(
  guardsRoot: string,
  protectedRoots: readonly string[],
): Promise<string | null> {
  return (
    (await prepareReusableDesignWatchIsolation(guardsRoot, protectedRoots, []))
      ?.nodeGuardPath ?? null
  );
}

export function nodeOptionsWithDesignWatchGuard(
  current: string | undefined,
  guardPath: string,
): string {
  const escaped = guardPath.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const required = `--require "${escaped}"`;
  const existing = current?.trim();
  if (!existing) return required;
  return existing.includes(required) ? existing : `${existing} ${required}`;
}

function pathsWithRequiredFile(
  current: string | undefined,
  required: string,
): string {
  const entries = (current ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    !entries.some((entry) => comparisonPath(entry) === comparisonPath(required))
  ) {
    entries.push(required);
  }
  return entries.join(path.delimiter);
}

/** Environment patch shared by ZSR repository processes and managed human
 * terminals. Existing user options are retained; engine-owned manifest names
 * always point at the immutable artifact set selected for this execution. */
export function designWatchIsolationEnvironment(
  current: Readonly<Record<string, string | undefined>>,
  artifacts: DesignWatchIsolationArtifacts,
): Record<string, string> {
  return {
    NODE_OPTIONS: nodeOptionsWithDesignWatchGuard(
      current.NODE_OPTIONS,
      artifacts.nodeGuardPath,
    ),
    WATCHEXEC_IGNORE_FILES: pathsWithRequiredFile(
      current.WATCHEXEC_IGNORE_FILES,
      artifacts.ignoreFilePath,
    ),
    ZEROS_DESIGN_WATCH_IGNORE_FILE: artifacts.ignoreFilePath,
    ZEROS_DESIGN_WATCH_ROOTS_FILE: artifacts.rootsFilePath,
  };
}
