import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../agent-runtime/config.mjs";
import { hash } from "../agent-runtime/contracts.mjs";
import { readBoundedRegularFile } from "../agent-runtime/files.mjs";
import { prepareUpdate } from "../agent-runtime/prepare.mjs";
import { installedDeclarationSurface } from "../agent-runtime/surfaces.mjs";

const race = vi.hoisted(() => ({
  target: "",
  beforeOpen: undefined as (() => void) | undefined,
  afterStat: undefined as (() => void) | undefined,
  beforeRead: undefined as (() => void) | undefined,
  descriptors: new Map<number, string>(),
  readBytes: 0,
  maxRead: Number.POSITIVE_INFINITY,
}));

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  function interleave(
    phase: "beforeOpen" | "afterStat" | "beforeRead",
    file?: string,
  ) {
    if (file !== race.target) return;
    const mutate = race[phase];
    race[phase] = undefined;
    mutate?.();
  }
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      interleave("beforeOpen", String(args[0]));
      const fd = fs.openSync(...args);
      if (args[0] === race.target) race.descriptors.set(fd, race.target);
      return fd;
    },
    closeSync: (fd: number) => {
      fs.closeSync(fd);
      race.descriptors.delete(fd);
    },
    lstatSync: (file: string) => {
      const stat = fs.lstatSync(file);
      interleave("afterStat", file);
      return stat;
    },
    fstatSync: (fd: number) => {
      const stat = fs.fstatSync(fd);
      interleave("afterStat", race.descriptors.get(fd));
      return stat;
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      interleave("beforeRead", String(args[0]));
      return fs.readFileSync(...args);
    },
    readSync: (
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      interleave("beforeRead", race.descriptors.get(fd));
      const count = fs.readSync(
        fd,
        buffer,
        offset,
        Math.min(length, race.maxRead),
        position,
      );
      if (race.descriptors.has(fd)) race.readBytes += count;
      return count;
    },
  };
});

const directories: string[] = [];
function temporaryDirectory() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "zeros-runtime-files-")),
  );
  directories.push(root);
  return root;
}

afterEach(() => {
  expect(race.descriptors.size).toBe(0);
  race.target = "";
  race.beforeOpen = undefined;
  race.afterStat = undefined;
  race.beforeRead = undefined;
  race.readBytes = 0;
  race.maxRead = Number.POSITIVE_INFINITY;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function installedPackage() {
  const root = temporaryDirectory();
  const directory = join(root, "node_modules", "@cursor", "sdk");
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ version: "1.0.0", types: "dist/sdk.d.ts" }),
  );
  const declaration = "export interface Options { approved: boolean }\n";
  const file = join(directory, "dist", "sdk.d.ts");
  writeFileSync(file, declaration);
  race.target = file;
  return { root, directory, file, declaration };
}

describe("runtime file read races", () => {
  it("rejects a generated output replaced after its metadata was checked", async () => {
    const root = temporaryDirectory();
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const lock = (version: string) =>
      `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@cursor/sdk':\n        specifier: ${version}\n        version: ${version}\npackages: {}\nsnapshots: {}\n`;
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@cursor/sdk": "1.0.0" } }) + "\n",
    );
    writeFileSync(join(root, "pnpm-lock.yaml"), lock("1.0.0"));
    const file = join(root, "THIRD-PARTY-LICENSES.txt");
    writeFileSync(file, "old licenses\n");
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Runtime test",
      "-c",
      "user.email=runtime-fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const head = git("rev-parse", "HEAD");
    const identity = {
      schema: 1,
      provider: "cursor",
      from: "1.0.0",
      version: "1.1.0",
      head,
      main: head,
      automation: head,
      branch: "automation/agent-runtime/cursor/012345abcdef",
      pr: 42,
      lastBotCommit: head,
      regenerate: false,
      createdAt: "2026-10-12T12:00:00.000Z",
    };
    const execute = (_: string, args: string[]) => {
      if (args.includes("--lockfile-only"))
        writeFileSync(join(root, "pnpm-lock.yaml"), lock("1.1.0"));
      if (args[0] === "scripts/generate-third-party-licenses.mjs") {
        writeFileSync(file, "new licenses\n");
        race.target = file;
        race.afterStat = () => {
          renameSync(file, join(root, "original-licenses"));
          writeFileSync(file, "unchecked replacement\n");
        };
      }
    };
    await expect(
      prepareUpdate(
        { ...identity, id: hash(identity) },
        {
          root,
          execute,
          inspect: async () => [],
        },
      ),
    ).rejects.toThrow();
    expect(race.afterStat).toBeUndefined();
  });

  it("rejects an installed declaration replaced after its metadata was checked", () => {
    const { root, file } = installedPackage();
    race.afterStat = () => {
      renameSync(file, `${file}.old`);
      writeFileSync(file, "export interface Unchecked { value: string }\n");
    };
    expect(() =>
      installedDeclarationSurface(root, "cursor", "1.0.0"),
    ).toThrow();
    expect(race.afterStat).toBeUndefined();
  });

  it("bounds the read when a declaration grows after validation", () => {
    const { root, file, declaration } = installedPackage();
    race.beforeRead = () => {
      // Whitespace keeps the oversized input syntactically valid for the parser.
      writeFileSync(file, declaration + " ".repeat(LIMITS.file));
    };
    expect(() =>
      installedDeclarationSurface(root, "cursor", "1.0.0"),
    ).toThrow();
    expect(race.beforeRead).toBeUndefined();
    expect(race.readBytes).toBeLessThanOrEqual(
      Buffer.byteLength(declaration) + 1,
    );
  });

  it("rejects a declaration swapped for an outside symlink before reading", () => {
    const { root, file } = installedPackage();
    const outside = join(temporaryDirectory(), "outside.d.ts");
    writeFileSync(outside, "export interface Outside { value: string }\n");
    race.beforeRead = () => {
      rmSync(file);
      symlinkSync(outside, file);
    };
    expect(() =>
      installedDeclarationSurface(root, "cursor", "1.0.0"),
    ).toThrow();
    expect(race.beforeRead).toBeUndefined();
  });

  it("rejects a parent directory swapped for an outside symlink before reading", () => {
    const { root, directory } = installedPackage();
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "sdk.d.ts"), "export interface Outside {}\n");
    race.beforeRead = () => {
      renameSync(join(directory, "dist"), join(directory, "original-dist"));
      symlinkSync(outside, join(directory, "dist"));
    };
    expect(() =>
      installedDeclarationSurface(root, "cursor", "1.0.0"),
    ).toThrow();
    expect(race.beforeRead).toBeUndefined();
  });

  it("rejects an already oversized declaration", () => {
    const { root, file } = installedPackage();
    truncateSync(file, LIMITS.file + 1);
    expect(() =>
      installedDeclarationSurface(root, "cursor", "1.0.0"),
    ).toThrow();
    expect(race.readBytes).toBe(0);
  });

  it("reads declarations through a pnpm-style package-root symlink", () => {
    const { root, directory } = installedPackage();
    const installed = join(root, "node_modules", "installed-sdk");
    renameSync(directory, installed);
    symlinkSync(installed, directory);
    race.target = join(installed, "dist", "sdk.d.ts");
    expect(installedDeclarationSurface(root, "cursor", "1.0.0")).toEqual({
      "dist/sdk.d.ts:Options": [
        "export interface Options {\n    approved: boolean;\n}",
      ],
    });
  });

  it("refuses a leaf symlink introduced immediately before opening", () => {
    const { root, file } = installedPackage();
    const outside = join(temporaryDirectory(), "outside.d.ts");
    writeFileSync(outside, "export interface Outside {}\n");
    race.beforeOpen = () => {
      rmSync(file);
      symlinkSync(outside, file);
    };
    expect(() =>
      installedDeclarationSurface(root, "cursor", "1.0.0"),
    ).toThrow();
    expect(race.beforeOpen).toBeUndefined();
    expect(race.readBytes).toBe(0);
  });

  it("refuses a parent symlink introduced immediately before opening", () => {
    const { root, directory } = installedPackage();
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "sdk.d.ts"), "export interface Outside {}\n");
    race.beforeOpen = () => {
      renameSync(join(directory, "dist"), join(directory, "original-dist"));
      symlinkSync(outside, join(directory, "dist"));
    };
    expect(() =>
      installedDeclarationSurface(root, "cursor", "1.0.0"),
    ).toThrow();
    expect(race.beforeOpen).toBeUndefined();
    expect(race.readBytes).toBe(0);
  });

  it("preserves short reads and empty regular files", () => {
    const { directory, file, declaration } = installedPackage();
    race.maxRead = 3;
    expect(
      readBoundedRegularFile(directory, "dist/sdk.d.ts").toString("utf8"),
    ).toBe(declaration);
    writeFileSync(file, "");
    expect(readBoundedRegularFile(directory, "dist/sdk.d.ts")).toHaveLength(0);
  });

  it("rejects executable generated files while allowing executable package files", () => {
    const { root, directory, file } = installedPackage();
    chmodSync(file, 0o755);
    expect(() =>
      readBoundedRegularFile(directory, "dist/sdk.d.ts", {
        allowExecutable: false,
      }),
    ).toThrow("permissions");
    expect(race.readBytes).toBe(0);
    expect(installedDeclarationSurface(root, "cursor", "1.0.0")).toHaveProperty(
      "dist/sdk.d.ts:Options",
    );
  });

  it("rejects a directory without trying to read its contents as a file", () => {
    const { directory } = installedPackage();
    race.target = join(directory, "dist");
    expect(() => readBoundedRegularFile(directory, "dist")).toThrow(
      "regular file",
    );
    expect(race.readBytes).toBe(0);
  });

  it("closes the descriptor when reading fails", () => {
    const { root } = installedPackage();
    race.beforeRead = () => {
      throw new Error("synthetic read failure");
    };
    expect(() => installedDeclarationSurface(root, "cursor", "1.0.0")).toThrow(
      "synthetic read failure",
    );
    expect(race.beforeRead).toBeUndefined();
  });
});
