import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cloudWorkspaceForkStageRoot,
  materializeCloudWorkspaceFork,
  readCloudWorkspaceForkBlob,
  removeCloudWorkspaceForkStage,
  stageCloudWorkspaceForkBlob,
} from "../cloud-workspace-fork-stage";
import type { CloudWorkspaceForkJobEntry } from "../cloud-workspace-fork-state";

let root: string;

function descriptor(
  ordinal: number,
  entryPath: string,
  bytes: Uint8Array,
  entryType: "file" | "symlink" = "file",
): Extract<CloudWorkspaceForkJobEntry, { operation: "upsert" }> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    ordinal,
    path: entryPath,
    portablePathKey: entryPath.normalize("NFKC").toLocaleLowerCase("en-US"),
    operation: "upsert",
    entryType,
    mode: entryType === "symlink" ? 40960 : 33188,
    contentSha256: sha256,
    sizeBytes: bytes.byteLength,
    stageName: sha256,
    remoteBlobId: null,
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-fork-stage-"));
  process.env.ZEROS_DATA_DIR = path.join(root, "data");
});

afterEach(async () => {
  delete process.env.ZEROS_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});

describe("cloud workspace copy staging", () => {
  it("stages verified content and materializes file/directory transitions", async () => {
    const jobId = randomUUID();
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(workspace, "replace-dir"), { recursive: true });
    await writeFile(path.join(workspace, "replace-dir", "child"), "old\n");
    await writeFile(path.join(workspace, "replace-file"), "old\n");
    await mkdir(path.join(workspace, "gone"));
    await writeFile(path.join(workspace, "gone", "file"), "old\n");
    const fileBytes = Buffer.from("directory became file\n");
    const childBytes = Buffer.from("file became directory\n");
    for (const bytes of [fileBytes, childBytes]) {
      await stageCloudWorkspaceForkBlob({
        jobId,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      });
    }
    const deletion = (
      ordinal: number,
      entryPath: string,
    ): CloudWorkspaceForkJobEntry => ({
      ordinal,
      path: entryPath,
      portablePathKey: entryPath.toLowerCase(),
      operation: "delete",
      entryType: null,
      mode: null,
      contentSha256: null,
      sizeBytes: null,
      stageName: null,
      remoteBlobId: null,
    });
    await materializeCloudWorkspaceFork({
      jobId,
      workspaceRoot: workspace,
      entries: [
        deletion(0, "replace-dir/child"),
        deletion(1, "replace-file"),
        deletion(2, "gone/file"),
        descriptor(3, "replace-dir", fileBytes),
        descriptor(4, "replace-file/child", childBytes),
      ],
    });
    expect(await readFile(path.join(workspace, "replace-dir"), "utf8")).toBe(
      "directory became file\n",
    );
    expect(await readFile(path.join(workspace, "replace-file", "child"), "utf8")).toBe(
      "file became directory\n",
    );
    await expect(lstat(path.join(workspace, "gone", "file"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const staged = await readCloudWorkspaceForkBlob({
      jobId,
      stageName: descriptor(0, "x", fileBytes).stageName,
      sha256: descriptor(0, "x", fileBytes).contentSha256,
      sizeBytes: fileBytes.byteLength,
    });
    expect(staged).toEqual(fileBytes);
    staged.fill(0);
    const stageRoot = await cloudWorkspaceForkStageRoot(jobId);
    await removeCloudWorkspaceForkStage(jobId);
    await expect(lstat(stageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects escaping symlinks and portable path collisions", async () => {
    const jobId = randomUUID();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const target = Buffer.from("../../outside");
    const link = descriptor(0, "src/link", target, "symlink");
    await stageCloudWorkspaceForkBlob({
      jobId,
      sha256: link.contentSha256,
      bytes: target,
    });
    await expect(
      materializeCloudWorkspaceFork({ jobId, workspaceRoot: workspace, entries: [link] }),
    ).rejects.toThrow(/escapes/);

    const a = descriptor(0, "Readme.md", Buffer.from("a"));
    const b = descriptor(1, "README.md", Buffer.from("b"));
    b.portablePathKey = a.portablePathKey;
    await expect(
      materializeCloudWorkspaceFork({ jobId, workspaceRoot: workspace, entries: [a, b] }),
    ).rejects.toThrow(/collide/);
  });
});
