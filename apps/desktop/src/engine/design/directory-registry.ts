// ──────────────────────────────────────────────────────────
// Design directory registry — which folder is "the design folder" per workspace
// ──────────────────────────────────────────────────────────
//
// The design folder's NAME is configuration (`[design] directory` in the
// settings layers — committed team default, per-machine override, per-worktree
// pin), but the thirty-plus code paths that join it onto a workspace path are
// SYNCHRONOUS (document reads, protocol resources, component expansion, lock
// sweeps). This tiny module bridges the two: the engine resolves the setting
// asynchronously at well-defined moments (boot, create, restore, mode entry,
// settings change — see design/directory.ts) and PRIMES the answer here; every
// sync consumer just asks.
//
// Deliberately dependency-free: document.ts, components.ts,
// protocol-resource.ts and workspace-lock.ts all import it, so anything it
// imported would be welded into every one of those graphs (components.ts ←
// document.ts already forms a cycle risk on its own).
//
// Keys are `path.resolve`d workspace paths — the same normalization
// document.ts applies before joining. An unprimed workspace answers the
// historical default, so pre-pointer behavior is unchanged.
// ──────────────────────────────────────────────────────────

import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

/** The default design folder name — and the only one pre-pointer builds knew.
 *  (Kept here so the registry has no imports; design/document.ts re-exports it
 *  as the public constant.) */
export const DEFAULT_DESIGN_DIRECTORY_NAME = "Zeros Design";

/** The marker that makes a folder a recognized Design document in Git's index or
 *  HEAD. Lives here for the same reason as the default name: code-agent admission
 *  has to name this file (it is write-denied so a fenced agent cannot
 *  de-register a Design folder), and admission must not drag document.ts —
 *  parse5, postcss, @zeros/design-web — into its import graph to learn one
 *  filename. design/document.ts re-exports it as the public constant. */
export const DESIGN_CANVAS_FILE = ".zeros-canvas.json";

const names = new Map<string, string>();
const readLeaseStorage = new AsyncLocalStorage<ReadonlyMap<string, string>>();

function keyFor(workspacePath: string): string {
  return path.resolve(workspacePath);
}

/** Basic shape guard for a primed name: repo-relative, POSIX separators, no
 *  traversal, no absolute path. The full validation (existence, spelling,
 *  segment realpath checks) lives with the resolver and the lock — this only
 *  keeps a corrupt setting from becoming a path-join escape. Returns null for
 *  an unusable name so callers fall back to the default. */
export function sanitizeDesignDirectoryName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const posix = raw.replace(/\\/g, "/").trim();
  if (!posix || posix === "." || posix === "/") return null;
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return null;
  if (/[\n\r\0]/.test(posix)) return null;
  const segments = posix.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((s) => s === "." || s === "..")) return null;
  // `.zeros/` is the settings dir, `.git` is git's own — a design folder in
  // either would let the design write path reach engine/git state.
  if (segments[0] === ".git" || segments[0] === ".zeros") return null;
  return segments.join("/");
}

/** Record the resolved design folder name for a workspace. Pass null/undefined
 *  (or an invalid name) to clear back to the default. */
export function primeDesignDirectoryName(
  workspacePath: string,
  name: string | null | undefined,
): void {
  const sanitized = sanitizeDesignDirectoryName(name);
  if (!sanitized || sanitized === DEFAULT_DESIGN_DIRECTORY_NAME) {
    names.delete(keyFor(workspacePath));
    return;
  }
  names.set(keyFor(workspacePath), sanitized);
}

/** The design folder name for a workspace — repo-relative, POSIX separators,
 *  possibly nested ("apps/web/designs"). Defaults to "Zeros Design" until the
 *  engine primes something else. */
export function designDirectoryNameFor(workspacePath: string): string {
  const key = keyFor(workspacePath);
  return (
    readLeaseStorage.getStore()?.get(key) ??
    names.get(key) ??
    DEFAULT_DESIGN_DIRECTORY_NAME
  );
}

/** Temporarily teach synchronous Design readers which directory an immutable
 * projection contains. Context projections are content-addressed workspace
 * roots, not registered workspaces, so retaining their names forever would
 * leak one registry entry per committed Design generation. The ref-counted
 * lease also keeps concurrent reads of the same projection from clearing one
 * another's answer. */
export async function withDesignDirectoryNameLease<T>(
  workspacePath: string,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const sanitized = sanitizeDesignDirectoryName(name);
  if (!sanitized) {
    throw new Error("The leased Design directory name is invalid.");
  }
  const key = keyFor(workspacePath);
  const retained = readLeaseStorage.getStore();
  const active = retained?.get(key);
  if (active && active !== sanitized) {
    throw new Error(
      "A nested Design read disagrees about the active directory.",
    );
  }
  if (active === sanitized) return run();
  const next = new Map(retained ?? []);
  next.set(key, sanitized);
  return readLeaseStorage.run(next, run);
}

/** Drop a workspace's entry (archive/delete) so a future checkout at the same
 *  path starts from the default again. */
export function forgetDesignDirectoryName(workspacePath: string): void {
  const key = keyFor(workspacePath);
  names.delete(key);
}

/** Test seam. */
export function resetDesignDirectoryRegistryForTests(): void {
  names.clear();
}
