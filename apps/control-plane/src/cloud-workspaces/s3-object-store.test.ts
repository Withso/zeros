import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { S3CloudWorkspaceObjectStore } from "./s3-object-store.js";

const key =
  "workspace/v2/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/k1";

function fixture() {
  const objects = new Map<
    string,
    { bytes: Buffer; metadata?: Record<string, string> }
  >();
  const send = vi.fn(
    async (
      command: PutObjectCommand | GetObjectCommand | HeadObjectCommand,
    ) => {
      const current = objects.get(command.input.Key!);
      if (command instanceof PutObjectCommand) {
        if (current && command.input.IfNoneMatch === "*")
          throw { $metadata: { httpStatusCode: 412 } };
        objects.set(command.input.Key!, {
          bytes: Buffer.from(command.input.Body as Uint8Array),
          ...(command.input.Metadata
            ? { metadata: command.input.Metadata }
            : {}),
        });
        return {};
      }
      if (!current) throw { $metadata: { httpStatusCode: 404 } };
      return {
        ContentLength: current.bytes.length,
        Metadata: current.metadata,
        ...(command instanceof GetObjectCommand
          ? { Body: Readable.from([current.bytes]) }
          : {}),
      };
    },
  );
  return {
    store: new S3CloudWorkspaceObjectStore(
      { send } as unknown as S3Client,
      "workspace-objects",
    ),
    send,
  };
}

describe("S3 immutable workspace objects", () => {
  it("preserves the winning ciphertext during concurrent immutable publications", async () => {
    const { store } = fixture();
    expect(await store.get(key)).toBeNull();
    expect(
      await Promise.all([
        store.putIfAbsent(key, Buffer.from("one")),
        store.putIfAbsent(key, Buffer.from("two")),
      ]),
    ).toEqual(["created", "already_exists"]);
    expect(await store.get(key)).toEqual(Buffer.from("one"));
  });

  it("never resurrects a removed object, including a key deleted before its delayed first PUT", async () => {
    const { store } = fixture();
    await store.deleteAndFence(key);
    await expect(store.putIfAbsent(key, Buffer.from("late"))).rejects.toThrow(
      "permanently fenced",
    );
    await store.delete(key);
    await store.deleteAndFence(key);
    await expect(store.putIfAbsent(key, Buffer.from("later"))).rejects.toThrow(
      "permanently fenced",
    );
    expect(await store.get(key)).toBeNull();
  });

  it("keeps deletion authoritative when publication races it", async () => {
    const { store } = fixture();
    await Promise.all([
      store.putIfAbsent(key, Buffer.from("racing")),
      store.deleteAndFence(key),
    ]);
    expect(await store.get(key)).toBeNull();
    await expect(store.putIfAbsent(key, Buffer.from("retry"))).rejects.toThrow(
      "permanently fenced",
    );
  });

  it("rejects invalid keys without issuing a storage request", async () => {
    const { store, send } = fixture();
    await expect(store.get("../other-tenant")).rejects.toThrow("invalid");
    await expect(store.deleteAndFence(`${key}/../k2`)).rejects.toThrow(
      "invalid",
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds downloads even when the server lies about the size and closes the body", async () => {
    const { store, send } = fixture();
    const body = Readable.from([Buffer.from("too long")]);
    send.mockResolvedValueOnce({ ContentLength: 1, Body: body });
    await expect(store.get(key)).rejects.toThrow("download failed");
    expect(body.destroyed).toBe(true);
  });

  it("rejects oversized readback headers before consuming a tiny upload's reserved budget", async () => {
    const {store,send}=fixture();
    const body=Readable.from([Buffer.from("x")]);
    const read=vi.spyOn(body,"read");
    send.mockResolvedValueOnce({ContentLength:64*1024*1024,Body:body});
    await expect(store.get(key,{expectedBytes:1})).rejects.toThrow("download failed");
    expect(read).not.toHaveBeenCalled();expect(body.destroyed).toBe(true);
  });

  it("rejects corrupt headers across concurrent tiny reads without consuming any payload", async () => {
    const { store, send } = fixture();
    const bodies = Array.from({ length: 32 }, () => Readable.from([Buffer.from("x")]));
    const reads = bodies.map(body => vi.spyOn(body, "read"));
    for (const body of bodies) send.mockResolvedValueOnce({ ContentLength: 64 * 1024 * 1024, Body: body });
    const results = await Promise.allSettled(bodies.map(() => store.get(key, { expectedBytes: 1 })));
    expect(results.every(result => result.status === "rejected")).toBe(true);
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(bodies.every(body => body.destroyed)).toBe(true);
  });

  it.each([0, 3])("reads exact %i-byte ciphertext, including empty files", async length => {
    const { store } = fixture();
    await store.putIfAbsent(key, Buffer.alloc(length, 1));
    expect(await store.get(key, { expectedBytes: length })).toEqual(Buffer.alloc(length, 1));
  });

  it.each([
    { declared: undefined, chunks: ["x"] },
    { declared: 1, chunks: ["x", "overflow"] },
    { declared: 1, chunks: [] },
  ])("rejects missing, lying or incomplete lengths: $declared / $chunks", async ({ declared, chunks }) => {
    const { store, send } = fixture();
    const body = Readable.from(chunks.map(chunk => Buffer.from(chunk)));
    send.mockResolvedValueOnce({ ContentLength: declared, Body: body });
    await expect(store.get(key, { expectedBytes: 1 })).rejects.toThrow("download failed");
    expect(body.destroyed).toBe(true);
  });

  it("fails closed on storage failures without disclosing SDK secrets", async () => {
    const { store, send } = fixture();
    send.mockRejectedValueOnce(new Error("signed-url-secret"));
    await expect(store.get(key)).rejects.toThrow(
      /^workspace object download failed$/,
    );
  });

  it("honors cancellation while a storage response is fragmented into tiny chunks", async () => {
    const { store, send } = fixture();
    const controller = new AbortController();
    const body = Readable.from(Array.from({ length: 4096 }, () => Buffer.from("x")));
    send.mockResolvedValueOnce({ ContentLength: 4096, Body: body });
    const abort = setImmediate(() => controller.abort());
    try {
      await expect(store.get(key, { expectedBytes: 4096, signal: controller.signal })).rejects.toThrow("download failed");
      expect(body.destroyed).toBe(true);
    } finally { clearImmediate(abort); }
  });
});
