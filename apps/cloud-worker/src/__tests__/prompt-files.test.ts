import { mkdtemp, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { preparePromptFiles } from "../prompt-files";
import { WorkspaceScope } from "../workspace/scope";
import { config } from "./worker-fixtures";

const dirs: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zeros-prompt-files-")); dirs.push(root);
  return { root, scope: new WorkspaceScope({ ...config.workspace, checkoutPath: root }) };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const file = (name = "notes.txt", bytes = "hello") => ({ type: "resource" as const,
  resource: { uri: `zeros-attachment://attachment-1/${encodeURIComponent(name)}`, mimeType: "text/plain", blob: Buffer.from(bytes).toString("base64") } });

it("materializes durable attachment bytes before dispatch and gives every driver a file reference", async () => {
  const f = await fixture(), content = [file()];
  const result = await preparePromptFiles(f.scope, content);
  const path = join(f.root, ".context/local/attachments/attachment-1/notes.txt");
  expect(await readFile(path, "utf8")).toBe("hello");
  expect(result).toEqual([{ type: "text", text: expect.stringContaining(JSON.stringify(path)) }]);
  expect(result[0]).not.toHaveProperty("resource");
  expect(await preparePromptFiles(f.scope, content)).toEqual(result);
  expect(content).toEqual([file()]); // Stored delivery/hash remains unchanged.
  await expect(preparePromptFiles(f.scope, [file("notes.txt", "changed")])).rejects.toThrow(/attachment/i);
  expect(await readFile(path, "utf8")).toBe("hello");
});

it("refuses an attachment path escape or an outside symlink without writing bytes", async () => {
  const f = await fixture(), outside = await fixture();
  await expect(preparePromptFiles(f.scope, [file("../escape.txt")])).rejects.toThrow(/attachment/i);
  await mkdir(join(f.root, ".context"));
  await symlink(outside.root, join(f.root, ".context/local"));
  await expect(preparePromptFiles(f.scope, [file()])).rejects.toThrow();
  await expect(readFile(join(outside.root, "attachments/attachment-1/notes.txt"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects malformed binary content and leaves ordinary prompt blocks untouched", async () => {
  const f = await fixture();
  await expect(preparePromptFiles(f.scope, [{ ...file(), resource: { ...file().resource, blob: "invalid%%" } }])).rejects.toThrow(/attachment/i);
  const ordinary = [{ type: "text" as const, text: "ok" }, { type: "image" as const, mimeType: "image/png", data: "AA==" }];
  expect(await preparePromptFiles(f.scope, ordinary)).toEqual(ordinary);
});
