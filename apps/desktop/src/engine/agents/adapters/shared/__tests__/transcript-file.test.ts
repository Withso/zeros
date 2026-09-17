import { afterEach, describe, expect, it } from "vitest";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openOwnedTranscript, ownedTranscriptPath } from "../transcript-file";

const homes: string[] = [];

async function providerHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zeros-transcript-"));
  homes.push(home);
  await mkdir(join(home, "sessions"), { recursive: true });
  return home;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("openOwnedTranscript", () => {
  it("opens a transcript inside the provider home and reports the opened inode", async () => {
    const home = await providerHome();
    const path = join(home, "sessions", "rollout.jsonl");
    await writeFile(path, '{"id":"one"}\n');

    const { handle, stat } = await openOwnedTranscript(home, path);
    try {
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBe(13);
      const buffer = Buffer.alloc(stat.size);
      await handle.read(buffer, 0, buffer.length, 0);
      expect(buffer.toString("utf8")).toBe('{"id":"one"}\n');
    } finally {
      await handle.close();
    }
  });

  it("refuses a transcript outside the provider home", async () => {
    const home = await providerHome();
    const elsewhere = await providerHome();
    const path = join(elsewhere, "sessions", "rollout.jsonl");
    await writeFile(path, "{}\n");

    await expect(openOwnedTranscript(home, path)).rejects.toThrow(/outside its provider home/);
  });

  it("refuses a relative pointer", async () => {
    const home = await providerHome();
    await expect(openOwnedTranscript(home, "sessions/rollout.jsonl")).rejects.toThrow(/must be absolute/);
  });

  it("refuses a symlink that redirects out of the provider home", async () => {
    const home = await providerHome();
    const outside = await providerHome();
    const target = join(outside, "secret.jsonl");
    await writeFile(target, '{"secret":true}\n');
    const path = join(home, "sessions", "rollout.jsonl");
    await symlink(target, path);

    await expect(openOwnedTranscript(home, path)).rejects.toThrow(/contains a symlink/);
    await expect(ownedTranscriptPath(home, path)).rejects.toThrow(/contains a symlink/);
  });

  it("refuses a symlinked parent directory", async () => {
    const home = await providerHome();
    const outside = await providerHome();
    await writeFile(join(outside, "rollout.jsonl"), "{}\n");
    await symlink(outside, join(home, "linked"));

    await expect(
      openOwnedTranscript(home, join(home, "linked", "rollout.jsonl")),
    ).rejects.toThrow(/contains a symlink/);
  });

  // A second name for the same inode means a writer outside the provider's
  // tree can keep mutating what is read, so the link count is part of the
  // contract and is now asserted against the descriptor rather than the path.
  it("refuses a hard-linked transcript", async () => {
    const home = await providerHome();
    const path = join(home, "sessions", "rollout.jsonl");
    await writeFile(path, "{}\n");
    await link(path, join(home, "sessions", "alias.jsonl"));

    await expect(openOwnedTranscript(home, path)).rejects.toThrow(/not a private regular file/);
  });

  it("refuses a directory standing where the transcript should be", async () => {
    const home = await providerHome();
    const path = join(home, "sessions", "rollout.jsonl");
    await mkdir(path);

    await expect(openOwnedTranscript(home, path)).rejects.toThrow(/not a private regular file/);
  });

  it("refuses a traversal that climbs out of the provider home", async () => {
    const home = await providerHome();
    const outside = await providerHome();
    await writeFile(join(outside, "rollout.jsonl"), "{}\n");

    await expect(
      openOwnedTranscript(home, join(home, "sessions", "..", "..", "escape.jsonl")),
    ).rejects.toThrow(/outside its provider home/);
  });
});
