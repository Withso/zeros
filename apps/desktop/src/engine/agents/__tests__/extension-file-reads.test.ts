import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativeExtensionInventory } from "../native-extensions";
import { readSkillFile } from "../zeros-skills";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    fstatSync: vi.fn(actual.fstatSync),
  };
});
const actual = await vi.importActual<typeof fs>("node:fs");

describe("extension file read races", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-extension-reads-"));
  });
  afterEach(() => {
    vi.mocked(fs.statSync).mockImplementation(actual.statSync);
    vi.mocked(fs.fstatSync).mockImplementation(actual.fstatSync);
    fs.rmSync(root, { recursive: true, force: true });
  });

  function afterInspection(file: string, change: () => void): void {
    const original = actual.statSync(file);
    let changed = false;
    const inspect = (info: fs.Stats) => {
      if (!changed && info.ino === original.ino && info.dev === original.dev) {
        changed = true;
        change();
      }
      return info;
    };
    vi.mocked(fs.statSync).mockImplementation(((target: fs.PathLike) =>
      inspect(actual.statSync(target))) as typeof fs.statSync);
    vi.mocked(fs.fstatSync).mockImplementation(((fd: number) =>
      inspect(actual.fstatSync(fd))) as typeof fs.fstatSync);
  }

  const kinds = ["native", "skill"] as const;
  function fixture(kind: (typeof kinds)[number]) {
    const file = path.join(
      root,
      kind === "native" ? ".cursor/mcp.json" : "SKILL.md",
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const source =
      kind === "native"
        ? JSON.stringify({ mcpServers: { original: { command: "node" } } })
        : "---\nname: original\n---\nOriginal skill";
    fs.writeFileSync(file, source);
    return {
      file,
      source,
      read: () =>
        kind === "native"
          ? nativeExtensionInventory(
              { provider: "cursor", category: "mcp" },
              { home: root, env: {} },
            )
          : readSkillFile(file),
    };
  }

  it.each(kinds)(
    "reads the inspected %s file when its path is replaced",
    (kind) => {
      const { file, source, read } = fixture(kind);
      const expected = read();
      afterInspection(file, () => {
        fs.renameSync(file, `${file}.old`);
        fs.writeFileSync(file, source.replaceAll("original", "replacement"));
      });
      expect(read()).toEqual(expected);
    },
  );

  it.each(kinds)(
    "rejects a %s file that grows beyond its inspected size",
    (kind) => {
      const { file, read } = fixture(kind);
      afterInspection(file, () => {
        fs.appendFileSync(
          file,
          " ".repeat(kind === "native" ? 4 * 1024 * 1024 : 128 * 1024),
        );
      });
      if (kind === "native")
        expect(read()).toMatchObject({ partial: true, entries: [] });
      else expect(read()).toBeNull();
    },
  );
});
