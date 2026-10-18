import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readLocalHead } from "../local-head";

let gitDirectory: string;
const head = "1".repeat(40);
beforeEach(async () => {
  gitDirectory = await mkdtemp(path.join(tmpdir(), "zeros-head-metadata-"));
  await mkdir(path.join(gitDirectory, "refs/heads"), { recursive: true });
  await writeFile(path.join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(gitDirectory, "refs/heads/main"), `${head}\n`);
});
afterEach(async () => { await rm(gitDirectory, { recursive: true, force: true }); });

describe("Local HEAD metadata", () => {
  it("reads ordinary refs without retaining a value", async () => {
    expect(await readLocalHead(gitDirectory)).toBe(head);
    const next = "2".repeat(40);
    await writeFile(path.join(gitDirectory, "refs/heads/main"), `${next}\n`);
    expect(await readLocalHead(gitDirectory)).toBe(next);
  });

  it.each(["directory", "empty"])("falls back when commondir is %s", async (kind) => {
    const file = path.join(gitDirectory, "commondir");
    if (kind === "directory") await mkdir(file);
    else await writeFile(file, "\n");
    expect(await readLocalHead(gitDirectory)).toBeUndefined();
  });

  it("does not use an older packed ref when a loose ref cannot be read", async () => {
    const loose = path.join(gitDirectory, "refs/heads/main");
    await rm(loose);
    await mkdir(loose);
    await writeFile(path.join(gitDirectory, "packed-refs"), `${head} refs/heads/main\n`);
    expect(await readLocalHead(gitDirectory)).toBeUndefined();
  });
});
