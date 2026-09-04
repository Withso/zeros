import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  designRecognitionStorePath,
  rememberRecognizedDesignDirectories,
  stickyRecognizedDesignDirectories,
} from "../recognition-store";

let previousDataDir: string | undefined;
let dataRoot: string;
let workspace: string;

beforeEach(async () => {
  previousDataDir = process.env.ZEROS_DATA_DIR;
  const root = await mkdtemp(path.join(tmpdir(), "zeros-design-recognition-"));
  dataRoot = path.join(root, "engine");
  workspace = path.join(root, "workspace");
  await Promise.all([
    mkdir(dataRoot, { recursive: true }),
    mkdir(path.join(workspace, "Product Design"), { recursive: true }),
    mkdir(path.join(workspace, "docs", "Brand Design"), { recursive: true }),
  ]);
  process.env.ZEROS_DATA_DIR = dataRoot;
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
  else process.env.ZEROS_DATA_DIR = previousDataDir;
  await rm(path.dirname(dataRoot), { recursive: true, force: true });
});

describe("sticky Design recognition", () => {
  it("remembers admitted Design folders and merges later admissions", async () => {
    await rememberRecognizedDesignDirectories(workspace, ["Product Design"]);
    expect(await stickyRecognizedDesignDirectories(workspace)).toEqual([
      "Product Design",
    ]);

    // A second admission that saw a different set must ADD to the memory rather
    // than replace it: two chats in one workspace can legitimately resolve
    // different active Design folders, and forgetting one would drop its
    // protection on the next session.
    await rememberRecognizedDesignDirectories(workspace, ["docs/Brand Design"]);
    expect(await stickyRecognizedDesignDirectories(workspace)).toEqual([
      "docs/Brand Design",
      "Product Design",
    ]);
  });

  it("reports only folders that still exist, and prunes the rest on write", async () => {
    await rememberRecognizedDesignDirectories(workspace, [
      "Product Design",
      "docs/Brand Design",
    ]);
    await rm(path.join(workspace, "Product Design"), {
      recursive: true,
      force: true,
    });

    // The rule that keeps sticky protection from bricking a workspace: a folder
    // the user genuinely deleted must stop being demanded, or every later
    // admission fails with "the recognized Design folder is missing".
    expect(await stickyRecognizedDesignDirectories(workspace)).toEqual([
      "docs/Brand Design",
    ]);
    await rememberRecognizedDesignDirectories(workspace, ["docs/Brand Design"]);
    expect(
      JSON.parse(await readFile(designRecognitionStorePath(), "utf8")) as {
        workspaces: Record<string, { names: string[] }>;
      },
    ).toMatchObject({
      workspaces: {
        [path.resolve(workspace)]: { names: ["docs/Brand Design"] },
      },
    });
  });

  it("drops the workspace entry once none of its folders remain", async () => {
    await rememberRecognizedDesignDirectories(workspace, ["Product Design"]);
    await rm(path.join(workspace, "Product Design"), {
      recursive: true,
      force: true,
    });
    await rememberRecognizedDesignDirectories(workspace, []);
    expect(
      JSON.parse(await readFile(designRecognitionStorePath(), "utf8")) as {
        workspaces: Record<string, unknown>;
      },
    ).toEqual({ version: 1, workspaces: {} });
  });

  it("refuses names that could escape the workspace", async () => {
    await rememberRecognizedDesignDirectories(workspace, [
      "../outside",
      "/etc",
      ".git",
      ".zeros",
      "Product Design",
    ]);
    expect(await stickyRecognizedDesignDirectories(workspace)).toEqual([
      "Product Design",
    ]);
  });

  it("falls back to Git evidence when the store is unusable", async () => {
    await mkdir(path.dirname(designRecognitionStorePath()), {
      recursive: true,
    });
    await writeFile(designRecognitionStorePath(), "{not json");
    // A corrupt file must not fail admission: recognition still has the
    // repository's own evidence, and the memory rebuilds from it.
    await expect(stickyRecognizedDesignDirectories(workspace)).resolves.toEqual(
      [],
    );
    await rememberRecognizedDesignDirectories(workspace, ["Product Design"]);
    expect(await stickyRecognizedDesignDirectories(workspace)).toEqual([
      "Product Design",
    ]);
  });
});
