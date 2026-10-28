import { chmod, lstat, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileService } from "../files";
import { repositoryFixture } from "./repository-fixture";

it("reads and atomically writes native or relative paths with Local's result shapes", async () => {
  const { scope, root } = await repositoryFixture();
  const files = new FileService(scope);
  await chmod(join(root, "readme.txt"), 0o755);
  expect(await files.handle("file.read", { workspaceId: scope.workspace.id, path: "readme.txt" })).toEqual({ kind: "text", path: "readme.txt", bytes: 8, content: "initial\n" });
  expect(await files.handle("file.write", { workspaceId: scope.workspace.id, path: join(root, "readme.txt"), content: "edited\n" })).toEqual({ kind: "success", path: "readme.txt", bytes: 7 });
  expect((await lstat(join(root, "readme.txt"))).mode & 0o777).toBe(0o755);
  expect(await readFile(join(root, "readme.txt"), "utf8")).toBe("edited\n");
  expect(await files.handle("file.write", { path: "new/nested.txt", content: "created" })).toMatchObject({ kind: "success" });
  expect(await files.handle("file.read", { path: "new/nested.txt" })).toMatchObject({ content: "created" });
});

it("rejects foreign identities, traversal and symlinks escaping the checkout", async () => {
  const { scope, root, directory } = await repositoryFixture();
  const files = new FileService(scope);
  await writeFile(join(directory, "outside.txt"), "outside fixture");
  await symlink(join(directory, "outside.txt"), join(root, "link.txt"));
  await symlink(directory, join(root, "link-dir"));
  for (const path of ["../outside.txt", join(directory, "outside.txt"), "link.txt", "link-dir/outside.txt", ".git/config", "bad\0path"]) {
    expect(await files.handle("file.read", { path })).toMatchObject({ kind: "error" });
    expect(await files.handle("file.write", { path, content: "replacement" })).toMatchObject({ kind: "error" });
  }
  expect(await readFile(join(directory, "outside.txt"), "utf8")).toBe("outside fixture");
  await expect(files.handle("file.tree", { workspaceId: "foreign" })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  await expect(files.handle("fs.listDir", { path: directory })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
});

it("follows an internal read symlink and confines directory listings", async () => {
  const { scope, root, directory } = await repositoryFixture();
  const files = new FileService(scope);
  await symlink("readme.txt", join(root, "internal.txt"));
  await mkdir(join(root, "src")); await mkdir(join(root, ".hidden"));
  await symlink(directory, join(root, "outside"));
  expect(await files.handle("file.read", { path: "internal.txt" })).toMatchObject({ kind: "text", content: "initial\n" });
  expect(await files.handle("fs.listDir", {})).toEqual({ path: root, parent: null, entries: [{ name: "src", path: join(root, "src") }] });
  expect(await files.handle("fs.listDir", { path: join(root, "src") })).toMatchObject({ path: join(root, "src"), parent: root });
});

it("bounds text, image and binary reads and oversized writes", async () => {
  const { scope, root } = await repositoryFixture(); const files = new FileService(scope);
  await writeFile(join(root, "binary.dat"), Buffer.from([65, 0, 66]));
  await writeFile(join(root, "image.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(root, "large.txt"), "x".repeat(2_000_001));
  expect(await files.handle("file.read", { path: "binary.dat" })).toEqual({ kind: "binary", path: "binary.dat", bytes: 3 });
  expect(await files.handle("file.read", { path: "image.png" })).toEqual({ kind: "image", path: "image.png", bytes: 4, dataUrl: "data:image/png;base64,iVBORw==" });
  expect(await files.handle("file.read", { path: "large.txt" })).toEqual({ kind: "too-large", path: "large.txt", bytes: 2_000_001 });
  expect(await files.handle("file.write", { path: "readme.txt", content: "x".repeat(2_000_001) })).toMatchObject({ kind: "too-large" });
  expect(await readFile(join(root, "readme.txt"), "utf8")).toBe("initial\n");
});

it("streams PDF documents without decoding their contents as source text", async () => {
  const { scope, root } = await repositoryFixture(); const files = new FileService(scope);
  const bytes = Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF");
  await writeFile(join(root, "report.PDF"), bytes);
  const result = await files.handle("file.read", { path: "report.PDF", streamMedia: true }) as { media: { version: string } };
  expect(result).toMatchObject({ kind: "binary", bytes: bytes.length,
    media: { mimeType: "application/pdf", version: expect.any(String) } });
  expect(await files.handle("file.readRange", { path: "report.PDF", version: result.media.version, offset: 0, length: bytes.length }))
    .toEqual({ base64: bytes.toString("base64"), bytes: bytes.length });
});

it("opts into video previews with Local's MIME, original bytes and media cap", async () => {
  const { scope, root } = await repositoryFixture(); const files = new FileService(scope);
  const bytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]);
  for (const [extension, mime] of [["MP4", "video/mp4"], ["webm", "video/webm"], ["mov", "video/quicktime"], ["m4v", "video/mp4"], ["ogv", "video/ogg"], ["mkv", "video/x-matroska"]]) {
    const path = `clip.${extension}`;
    await writeFile(join(root, path), bytes);
    expect(await files.handle("file.read", { path })).toMatchObject({ kind: "binary" });
    expect(await files.handle("file.read", { path, includeVideo: true })).toEqual({
      kind: "video", path, bytes: bytes.length, dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
    });
  }
  await writeFile(join(root, "large.mp4"), "");
  await truncate(join(root, "large.mp4"), 5 * 1024 * 1024 + 1);
  expect(await files.handle("file.read", { path: "large.mp4", includeVideo: true })).toEqual({
    kind: "too-large", path: "large.mp4", bytes: 5 * 1024 * 1024 + 1,
  });
});

it("lists exact Git paths, including newline names, and lazily expands ignored entries", async () => {
  const { scope, root } = await repositoryFixture(); const files = new FileService(scope);
  await writeFile(join(root, "line\nbreak.txt"), "new\n");
  await writeFile(join(root, ".gitignore"), "ignored/\n");
  await mkdir(join(root, "ignored")); await writeFile(join(root, "ignored/file.txt"), "ignored\n");
  expect(await files.handle("file.tree", {})).toEqual({ files: [".gitignore", "line\nbreak.txt", "readme.txt"] });
  expect(await files.handle("file.ignored", {})).toEqual({ entries: ["ignored/"] });
  expect(await files.handle("file.ignored", { dir: "ignored" })).toEqual({ entries: ["ignored/file.txt"] });
  expect(await files.handle("file.tree", { includeIgnored: true, query: "file.txt", limit: 1 })).toEqual({ files: ["ignored/file.txt"] });
});

it("returns metadata for 200 MB media and reads only the requested revision's range", async () => {
  const { scope, root } = await repositoryFixture(); const files = new FileService(scope);
  await writeFile(join(root, "large.mp4"), Buffer.from([0, 1, 2, 3]));
  await truncate(join(root, "large.mp4"), 200_000_000);
  const result = await files.handle("file.read", { path: "large.mp4", includeVideo: true, streamMedia: true }) as any;
  expect(result).toMatchObject({ kind: "video", bytes: 200_000_000, media: { mimeType: "video/mp4", version: expect.any(String) } });
  expect(result.dataUrl).toBeUndefined();
  expect(await files.handle("file.readRange", { path: "large.mp4", version: result.media.version, offset: 1, length: 2 }))
    .toEqual({ base64: "AQI=", bytes: 2 });
  expect(await files.handle("file.readRange", { path: "large.mp4", version: result.media.version, offset: 199_999_999, length: 8 }))
    .toEqual({ base64: "AA==", bytes: 1 });
  await expect(files.handle("file.readRange", { path: "large.mp4", version: result.media.version, offset: 0, length: 1024 * 1024 + 1 })).rejects.toThrow();
  await truncate(join(root, "large.mp4"), 200_000_001);
  await expect(files.handle("file.readRange", { path: "large.mp4", version: result.media.version, offset: 0, length: 4 })).rejects.toThrow();
  expect(await files.handle("file.read", { path: "large.mp4", includeVideo: true, streamMedia: true })).toMatchObject({ kind: "too-large" });
});
