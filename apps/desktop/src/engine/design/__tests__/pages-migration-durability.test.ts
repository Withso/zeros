import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every namespace change and fsync the migration makes, in order. Each fd
// maps back to the path it was opened with.
type Event =
  | { kind: "create" | "unlink" | "mkdir" | "rmdir"; path: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "fsync"; path: string; directory: boolean };
const recorded = vi.hoisted(() => ({ events: [] as Event[], fds: new Map<number, string>(), on: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const note = (event: Event) => { if (recorded.on) recorded.events.push(event); };
  const wrapped = {
    openSync: ((file: string, flags?: number | string, mode?: number) => {
      const fd = actual.openSync(file, flags as never, mode);
      recorded.fds.set(fd, path.resolve(String(file)));
      if (typeof flags === "number" ? (flags & actual.constants.O_CREAT) !== 0 : /[wa]/.test(String(flags ?? "")))
        note({ kind: "create", path: path.resolve(String(file)) });
      return fd;
    }) as typeof actual.openSync,
    fsyncSync: ((fd: number) => {
      actual.fsyncSync(fd);
      const file = recorded.fds.get(fd);
      if (file) note({ kind: "fsync", path: file, directory: actual.statSync(file).isDirectory() });
    }) as typeof actual.fsyncSync,
    renameSync: ((from: string, to: string) => {
      actual.renameSync(from, to);
      note({ kind: "rename", from: path.resolve(String(from)), to: path.resolve(String(to)) });
    }) as typeof actual.renameSync,
    unlinkSync: ((file: string) => {
      actual.unlinkSync(file);
      note({ kind: "unlink", path: path.resolve(String(file)) });
    }) as typeof actual.unlinkSync,
    mkdirSync: ((file: string, options?: Parameters<typeof actual.mkdirSync>[1]) => {
      const existed = actual.existsSync(file);
      const result = actual.mkdirSync(file, options);
      if (!existed) note({ kind: "mkdir", path: path.resolve(String(file)) });
      return result;
    }) as typeof actual.mkdirSync,
    rmdirSync: ((file: string, options?: Parameters<typeof actual.rmdirSync>[1]) => {
      actual.rmdirSync(file, options);
      note({ kind: "rmdir", path: path.resolve(String(file)) });
    }) as typeof actual.rmdirSync,
  };
  return { ...actual, ...wrapped, default: { ...actual, ...wrapped } };
});

import { DESIGN_DIRECTORY_NAME, initializeDesignDocument } from "../document";
import { readCanvas } from "../document-storage";
import { designPrivateStorageDirectory } from "../metadata-storage";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "zeros-migration-durability-")));
  process.env.ZEROS_DATA_DIR = path.join(root, "private");
  recorded.events.length = 0;
  recorded.fds.clear();
});
afterEach(() => {
  recorded.on = false;
  delete process.env.ZEROS_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

async function migrate(frames: number): Promise<Event[]> {
  const directory = path.join(root, DESIGN_DIRECTORY_NAME);
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < frames; index++)
    writeFileSync(path.join(directory, `frame-${String(index).padStart(4, "0")}.html`),
      `<!doctype html><html><head><title>Frame ${index}</title></head><body><main data-oid="m${index}">${index}</main></body></html>`);
  recorded.events.length = 0;
  recorded.on = true;
  await initializeDesignDocument(root);
  recorded.on = false;
  expect(Object.keys((await readCanvas(root)).frames)).toHaveLength(frames);
  return [...recorded.events];
}

const directorySyncs = (events: Event[]) => events.filter((event) => event.kind === "fsync" && event.directory).length;

describe("Design page migration durability", () => {
  it("syncs each changed directory once per phase, not once per frame", async () => {
    const few = directorySyncs(await migrate(10));
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const many = directorySyncs(await migrate(40));
    expect(many).toBe(few);
    expect(many).toBeLessThanOrEqual(30);
  });

  it("makes every file and namespace change durable before the step that depends on it", async () => {
    const events = await migrate(40);
    const privateRoot = realpathSync(designPrivateStorageDirectory(root));
    const design = realpathSync(path.join(root, DESIGN_DIRECTORY_NAME));
    const synced = new Set<string>();
    const unsynced = new Set<string>();
    const changed = (file: string) => unsynced.add(path.dirname(file));
    const assertDurableExcept = (step: string, directory?: string) =>
      expect([...unsynced].filter((candidate) => candidate !== directory), step).toEqual([]);
    let deleted = false;
    let checkpoints = 0;
    for (const event of events) {
      if (event.kind === "fsync") {
        if (event.directory) unsynced.delete(event.path);
        else synced.add(event.path);
        continue;
      }
      if (event.kind === "rename") {
        // A file is durable before its name is published.
        expect(synced.has(event.from), `fsync before rename of ${event.to}`).toBe(true);
        const name = path.basename(event.to);
        if (path.dirname(event.to) === privateRoot && /^(?:pages|page-generation)-[a-f0-9]{24}\.json$/.test(name)) {
          assertDurableExcept(`publish ${name}`, privateRoot);
          checkpoints++;
        }
        changed(event.from);
        changed(event.to);
        continue;
      }
      if (event.kind === "unlink") {
        const parent = path.dirname(event.path);
        if (!deleted && parent === design && !event.path.endsWith(".zeros-tmp")) {
          assertDurableExcept("first predecessor unlink");
          deleted = true;
          checkpoints++;
        }
        if (parent === privateRoot && /^pages-[a-f0-9]{24}\.json$/.test(path.basename(event.path))) {
          assertDurableExcept("journal removal");
          checkpoints++;
        }
      }
      changed(event.path);
    }
    expect(deleted).toBe(true);
    // The prepared, sources, metadata, deleted, invalidated and complete
    // phases, the cache generation, the first deletion and journal removal.
    expect(checkpoints).toBeGreaterThanOrEqual(9);
  });
});
