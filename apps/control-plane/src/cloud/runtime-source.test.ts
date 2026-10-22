import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { lookupRuntimeSource } from "./runtime-source.js";

const source = "a".repeat(64), sha256 = "b".repeat(64), commit = "c".repeat(40);
const storage = { endpoint: "https://storage.example.test", bucket: "runtimes", accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" };
const index = { version: 1, sourceSha256: source, sha256, commit };
function client(value: unknown = index) {
  return { destroy: vi.fn(), send: vi.fn(async (command: any) => command.constructor.name === "GetObjectCommand"
    ? { Body: Readable.from([Buffer.from(JSON.stringify(value))]) } : { ContentLength: 100 }) };
}
it("resolves an exact bounded source index only when its immutable runtime exists", async () => {
  const c = client();
  expect(await lookupRuntimeSource(source, storage, c as any)).toEqual(index);
  expect(c.send.mock.calls.map(([command]) => command.input.Key)).toEqual([
    `cloud-v2/runtime/sources/${source}.json`, `cloud-v2/runtime/${sha256}.tar.gz`,
  ]);
});
it("treats only an object 404 as absence; an auth or server failure cannot trigger publication", async () => {
  const c = client(); c.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
  expect(await lookupRuntimeSource(source, storage, c as any)).toBeNull();
  for (const status of [403, 500]) {
    c.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: status }, message: "fixture-secret" });
    await expect(lookupRuntimeSource(source, storage, c as any)).rejects.toThrow(/lookup/);
  }
});
it.each([{ ...index, sourceSha256: "d".repeat(64) }, { ...index, sha256: "../bad" }, { ...index, commit: "main" },
  { ...index, unexpected: "fixture-secret" }])("rejects malformed or mismatched metadata: %j", async value => {
  const c = client(value);
  await expect(lookupRuntimeSource(source, storage, c as any)).rejects.toThrow();
  expect(c.send).toHaveBeenCalledOnce();
});
it("bounds the body even if storage omits a length, and refuses an empty archive", async () => {
  const c = client("x".repeat(5000));
  await expect(lookupRuntimeSource(source, storage, c as any)).rejects.toThrow();
  const missing = client(); missing.send.mockResolvedValueOnce({ Body: Readable.from([Buffer.from(JSON.stringify(index))]) } as any)
    .mockResolvedValueOnce({ ContentLength: 0 } as any);
  await expect(lookupRuntimeSource(source, storage, missing as any)).rejects.toThrow();
});
