// ──────────────────────────────────────────────────────────
// Design recognition — STICKY memory of which folders are Design documents
// ──────────────────────────────────────────────────────────
//
// design/directory.ts recognizes a Design document from two pieces of REPOSITORY
// evidence: a `.zeros-canvas.json` marker in Git's index or HEAD, and the
// `[design] directory` pointer in `.zeros/settings*.toml`. Both are ordinary
// files in the checkout.
//
// Native Code has normal same-user authority, so it can edit the two things
// that decide what "recognized" means. `git rm --cached
// "My Design/.zeros-canvas.json"` plus a settings edit removes every trace of
// recognition from the repository.
//
// Recognition therefore also becomes engine-side state: once Zeros observes a
// Design root, its own path guards and later Design-agent admission continue to
// recognize that existing directory while repository evidence is in flight.
//
// THE ONE RULE THAT KEEPS THIS SAFE: a remembered name is normally honoured
// only while that directory still EXISTS on disk. Without it, a user who
// legitimately deletes a Design folder would hit "the recognized Design folder
// is missing from this checkout" on every future session.
//
// The store itself is engine data, not repository content. Design-agent ZSR
// cannot read or write it. Native Code remains unrestricted and could change it,
// so this memory is an application-safety backstop, not a hostile-Code security
// boundary.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { zerosDataDir } from "../db/paths";
import { sanitizeDesignDirectoryName } from "./directory-registry";

/** Bounded so a long-lived install cannot grow this file without limit, and so a
 * corrupted/hostile file cannot make admission do unbounded work. Eviction is by
 * least-recently-admitted, which for this data means "workspaces you stopped
 * using" — and a workspace that comes back re-remembers on its next admission
 * from live Git evidence. */
const MAX_WORKSPACES = 512;
const MAX_NAMES_PER_WORKSPACE = 64;
const MAX_STORE_BYTES = 1024 * 1024;

interface StoredWorkspace {
  readonly names: readonly string[];
  readonly seenAt: number;
}

interface StoredRecognition {
  readonly version: 1;
  readonly workspaces: Record<string, StoredWorkspace>;
}

/** Exported so the Design-agent policy and store cannot disagree about which
 * engine-owned path must be inaccessible. */
export function designRecognitionStorePath(): string {
  return path.join(zerosDataDir(), "design-recognition.json");
}

function workspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot);
}

/** Read the store, discarding anything that is not exactly the shape written
 * below. A malformed or truncated file is not an admission failure: recognition
 * still has its Git evidence, and the correct behavior is to rebuild the memory
 * from that rather than refuse to start a session. */
async function readStore(): Promise<StoredRecognition> {
  const empty: StoredRecognition = { version: 1, workspaces: {} };
  let raw: string;
  try {
    raw = await readFile(designRecognitionStorePath(), "utf8");
  } catch {
    return empty;
  }
  if (raw.length > MAX_STORE_BYTES) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    return empty;
  }
  const workspaces = (parsed as { workspaces?: unknown }).workspaces;
  if (!workspaces || typeof workspaces !== "object") return empty;
  const cleaned: Record<string, StoredWorkspace> = {};
  for (const [key, value] of Object.entries(
    workspaces as Record<string, unknown>,
  )) {
    if (!path.isAbsolute(key) || key.includes("\0")) continue;
    const names = (value as { names?: unknown })?.names;
    const seenAt = (value as { seenAt?: unknown })?.seenAt;
    if (!Array.isArray(names)) continue;
    const sanitized = [
      ...new Set(
        names.flatMap((name) => {
          const safe =
            typeof name === "string" ? sanitizeDesignDirectoryName(name) : null;
          return safe ? [safe] : [];
        }),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_NAMES_PER_WORKSPACE);
    if (sanitized.length === 0) continue;
    cleaned[key] = {
      names: sanitized,
      seenAt:
        typeof seenAt === "number" && Number.isFinite(seenAt) ? seenAt : 0,
    };
  }
  return { version: 1, workspaces: cleaned };
}

/** Names remembered for this workspace that still have a directory on disk.
 *
 * The existence filter is the safety rule from the module header, applied on
 * READ so it holds for every caller — including a preview that must not mutate
 * anything. A name whose folder is gone simply stops being reported, and the next
 * successful admission persists the shorter list. */
export async function stickyRecognizedDesignDirectories(
  workspaceRoot: string,
): Promise<string[]> {
  const store = await readStore();
  const entry = store.workspaces[workspaceKey(workspaceRoot)];
  if (!entry) return [];
  return entry.names.filter((name) =>
    existsSync(path.join(workspaceRoot, ...name.split("/"))),
  );
}

let writeTail: Promise<void> = Promise.resolve();

/** Record the Design folders an admission actually protected.
 *
 * Serialized in-process and written through a temp file + rename so a crash
 * mid-write leaves the previous memory intact rather than a truncated file.
 * Never throws: failing to remember is a weaker backstop, not a reason to refuse
 * a session that has already proven its fence. */
export async function rememberRecognizedDesignDirectories(
  workspaceRoot: string,
  names: readonly string[],
): Promise<void> {
  const key = workspaceKey(workspaceRoot);
  const incoming = [
    ...new Set(
      names.flatMap((name) => {
        const safe = sanitizeDesignDirectoryName(name);
        return safe ? [safe] : [];
      }),
    ),
  ];
  const operation = writeTail.then(async () => {
    const store = await readStore();
    const previous = store.workspaces[key]?.names ?? [];
    const merged = [...new Set([...previous, ...incoming])]
      .filter((name) =>
        existsSync(path.join(workspaceRoot, ...name.split("/"))),
      )
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_NAMES_PER_WORKSPACE);
    const workspaces = { ...store.workspaces };
    if (merged.length === 0) delete workspaces[key];
    else workspaces[key] = { names: merged, seenAt: Date.now() };
    const ordered = Object.entries(workspaces)
      .sort((left, right) => right[1].seenAt - left[1].seenAt)
      .slice(0, MAX_WORKSPACES);
    if (
      ordered.length === Object.keys(store.workspaces).length &&
      previous.length === merged.length &&
      previous.every((name, index) => merged[index] === name)
    ) {
      return;
    }
    const target = designRecognitionStorePath();
    const temporary = `${target}.${process.pid.toString()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      `${JSON.stringify({
        version: 1,
        workspaces: Object.fromEntries(ordered),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
  writeTail = operation.catch(() => undefined);
  await operation.catch(() => undefined);
}
