import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ELECTRON_ROOT = "apps/desktop/electron";

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(path);
    }
    return /\.[cm]?ts$/.test(entry.name) ? [path] : [];
  });
}

function commandTableNames(): Set<string> {
  const source = readFileSync(join(ELECTRON_ROOT, "ipc/router.ts"), "utf8");
  const start = source.indexOf(
    "const commandTable: Record<string, CommandHandler> = {",
  );
  const end = source.indexOf("\n};", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  return new Set(
    [...block.matchAll(/^\s*(?:["']([^"']+)["']|([a-z][\w]*))\s*:/gm)].map(
      (match) => match[1] ?? match[2]!,
    ),
  );
}

function staticallyRegisteredCommands(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(ELECTRON_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bsetCommand\(\s*["']([^"']+)["']/g)) {
      names.add(match[1]!);
    }
  }
  return names;
}

describe("Electron IPC command inventory", () => {
  it("declares every static command registration in the router table", () => {
    const table = commandTableNames();
    const missing = [...staticallyRegisteredCommands()]
      .filter((command) => !table.has(command))
      .sort();

    expect(missing).toEqual([]);
  });
});
