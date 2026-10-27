import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ATTACHMENT_CHUNK_BYTES } from "@zeros/protocol/attachment-policy";
import { WorkspaceService } from "../service";
import { repositoryFixture } from "./repository-fixture";

const services: WorkspaceService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });
async function fixture() {
  const fixture = await repositoryFixture();
  const service = await WorkspaceService.open(fixture.scope, fixture.state, { watch: false, lookupPr: async () => ({ prNumber: null, prState: null, prUrl: null }) });
  services.push(service);
  const args = { workspaceId: fixture.scope.workspace.id, cwd: fixture.root, attachmentId: "a", filename: "clip.mp4", mimeType: "video/mp4", uploadId: "upload-a", totalBytes: 3, offset: 0, base64: "" };
  return { ...fixture, service, args };
}
it("admits 500 MB transfers without allocating the file and never exposes incomplete bytes in the checkout", async () => {
  const { service, args, root, state } = await fixture();
  expect(await service.handle("attachment.write", { ...args, totalBytes: 500_000_000 })).toMatchObject({ pending: true, bytes: 0 });
  expect(await readdir(root)).not.toContain(".context");
  const files = await readdir(join(state, "attachment-uploads"));
  expect(files).toHaveLength(1);
  expect((await stat(join(state, "attachment-uploads", files[0]))).size).toBe(0);
  await expect(service.handle("attachment.write", { ...args, uploadId: "too-big", totalBytes: 500_000_001 })).rejects.toThrow(/500 MB/);
  await service.handle("attachment.write", { ...args, abort: true });
  expect(await readdir(join(state, "attachment-uploads"))).toEqual([]);
});
it("publishes complete original bytes, resolves metadata, and does not overwrite another attachment", async () => {
  const { service, args, root, state } = await fixture();
  expect(await service.handle("attachment.write", args)).toMatchObject({ pending: true });
  await service.handle("attachment.write", { ...args, base64: "AQI=" });
  expect(await readdir(root)).not.toContain(".context");
  const result = await service.handle("attachment.write", { ...args, offset: 2, base64: "Aw==" });
  expect(result).toMatchObject({ bytes: 3, relativePath: ".context/attachments/a/clip.mp4", absolutePath: join(root, ".context/attachments/a/clip.mp4") });
  expect(await readFile(join(root, ".context/attachments/a/clip.mp4"))).toEqual(Buffer.from([1, 2, 3]));
  expect(await readdir(join(state, "attachment-uploads"))).toEqual([]);
  expect(await service.handle("attachment.write", { ...args, resolve: true })).toMatchObject({ ...result as object, skipped: true });
  await expect(service.handle("attachment.write", { ...args, uploadId: "conflict", base64: "BAUG" })).rejects.toThrow(/exists|conflict|different/i);
  expect(await readFile(join(root, ".context/attachments/a/clip.mp4"))).toEqual(Buffer.from([1, 2, 3]));
});
it("validates chunk sizes, offsets, identity and path ownership before writing", async () => {
  const { service, args, root, directory } = await fixture();
  for (const invalid of [{ totalBytes: -1 }, { offset: 1 }, { attachmentId: "../bad" }, { nativeSourceId: "local-file" }, { base64: "!notbase64" },
    { totalBytes: ATTACHMENT_CHUNK_BYTES + 1, base64: Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1).toString("base64") }, { cwd: directory }, { workspaceId: "foreign" }])
    await expect(service.handle("attachment.write", { ...args, ...invalid })).rejects.toThrow();
  await writeFile(join(directory, "outside"), "unchanged");
  await symlink(directory, join(root, ".context"));
  await expect(service.handle("attachment.write", { ...args, base64: "AQID" })).rejects.toThrow();
  expect(await readFile(join(directory, "outside"), "utf8")).toBe("unchanged");
});
it("cleans partial files on worker disposal and accepts a real empty attachment", async () => {
  const { service, args, root, state } = await fixture();
  const result = await service.handle("attachment.write", { ...args, uploadId: "empty", attachmentId: "empty", totalBytes: 0 });
  expect(result).toMatchObject({ bytes: 0, relativePath: ".context/attachments/empty/clip.mp4" });
  expect((await stat(join(root, ".context/attachments/empty/clip.mp4"))).size).toBe(0);
  await service.handle("attachment.write", args);
  await service.dispose();
  expect(await readdir(join(state, "attachment-uploads"))).toEqual([]);
});
it("can retry after temporary storage becomes available without restarting the worker", async () => {
  const { service, args, root, state } = await fixture();
  const temporary = join(state, "attachment-uploads");
  await writeFile(temporary, "unavailable");
  await expect(service.handle("attachment.write", { ...args, base64: "AQID" })).rejects.toThrow();
  await rm(temporary);
  await expect(service.handle("attachment.write", { ...args, base64: "AQID" })).resolves.toMatchObject({ bytes: 3 });
  expect(await readFile(join(root, ".context/attachments/a/clip.mp4"))).toEqual(Buffer.from([1, 2, 3]));
  expect(await readdir(temporary)).toEqual([]);
});
it("refuses redirected attachment storage that the cloud checkpoint cannot retain", async () => {
  const { service, args, root, state } = await fixture();
  const redirected = join(root, "ignored-store");
  await mkdir(redirected);
  await symlink(redirected, join(root, ".context"));
  await expect(service.handle("attachment.write", { ...args, base64: "AQID" })).rejects.toThrow(/symbolic links/);
  expect(await readdir(join(state, "attachment-uploads"))).toEqual([]);
  await writeFile(join(redirected, "attachments/a/clip.mp4"), "saved");
  await expect(service.handle("attachment.write", { ...args, resolve: true })).rejects.toThrow(/symbolic links/);
});
