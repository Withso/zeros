import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readBoundedJsonFile } from "./bounded-json-file.js";

const race = vi.hoisted(() => ({ beforeRead: null as (() => void) | null }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      const replace = race.beforeRead;
      race.beforeRead = null;
      replace?.();
      return fs.readSync(...args);
    },
  };
});

it("does not echo malformed operator-document contents in errors", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-operator-json-"));
  const file = path.join(directory, "state.json");
  const content = 'PRIVATE_DOCUMENT_CANARY{"token":"fixture"';
  try {
    writeFileSync(file, content, { mode: 0o600 });
    expect(() => readBoundedJsonFile(file, 4096, true)).toThrow(
      /^Operator document is unsafe or invalid$/,
    );
    expect(readFileSync(file, "utf8")).toBe(content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects a private parent replaced after the descriptor was checked", () => {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-operator-parent-"));
  const parent = path.join(root, "active");
  const moved = path.join(root, "moved");
  const file = path.join(parent, "state.json");
  mkdirSync(parent, { mode: 0o700 });
  writeFileSync(file, '{"receipt":"original"}', { mode: 0o600 });
  race.beforeRead = () => {
    renameSync(parent, moved);
    mkdirSync(parent, { mode: 0o700 });
    writeFileSync(file, '{"receipt":"replacement"}', { mode: 0o600 });
  };
  try {
    expect(() => readBoundedJsonFile(file, 4096, true)).toThrow(/unsafe/);
    expect(readFileSync(file, "utf8")).toBe('{"receipt":"replacement"}');
    expect(readFileSync(path.join(moved, "state.json"), "utf8")).toBe(
      '{"receipt":"original"}',
    );
  } finally {
    race.beforeRead = null;
    rmSync(root, { recursive: true, force: true });
  }
});
