import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { setImmediate as yieldToIo } from "node:timers/promises";

import {
  assertCloudWorkspaceObjectKey,
  assertWorkspaceObjectReadOptions,
  MAX_WORKSPACE_CIPHERTEXT_BYTES,
  type CloudWorkspaceObjectStore,
  type WorkspaceObjectReadOptions,
} from "./object-store.js";

const FENCE_METADATA = "zeros-deletion-fence";
const FENCE_VERSION = "1";
const OPERATION_TIMEOUT_MS = 60_000;

function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
}

/** Shared, strongly consistent ciphertext storage. Deletion overwrites the SAME
 * immutable key with a zero-byte tombstone. If-None-Match publication can never
 * resurrect it, even when a delayed PUT reaches storage after deletion returns.
 * Bucket lifecycle rules must never remove tombstones or versioned ciphertext.
 * Workspace retention is enforced by the database maintenance worker. */
export class S3CloudWorkspaceObjectStore implements CloudWorkspaceObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error("workspace object bucket is invalid");
    }
  }

  async putIfAbsent(
    key: string,
    bytes: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<"created" | "already_exists"> {
    const timeout = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
    const signal = options?.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    signal.throwIfAborted();
    assertCloudWorkspaceObjectKey(key);
    if (bytes.byteLength > MAX_WORKSPACE_CIPHERTEXT_BYTES)
      throw new Error("workspace ciphertext is too large");
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: "application/octet-stream",
          CacheControl: "no-store",
          IfNoneMatch: "*",
        }),
        { abortSignal: signal },
      );
      return "created";
    } catch (error) {
      if (status(error) !== 412)
        throw new Error("workspace object upload failed");
      const head = await this.client
        .send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal: signal,
        })
        .catch(() => {
          throw new Error("workspace object state unavailable");
        });
      if (head.Metadata?.[FENCE_METADATA] === FENCE_VERSION)
        throw new Error("workspace object key is permanently fenced");
      return "already_exists";
    }
  }

  async get(key: string, options?: WorkspaceObjectReadOptions): Promise<Uint8Array | null> {
    assertCloudWorkspaceObjectKey(key);
    assertWorkspaceObjectReadOptions(options);
    let body: Readable | undefined;
    let allocated: Buffer | undefined;
    const controller = new AbortController();
    const abort = () => { controller.abort(); body?.destroy(new Error("object download deadline")); };
    const deadline = setTimeout(abort, OPERATION_TIMEOUT_MS);
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (options?.signal?.aborted) abort();
    deadline.unref();
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: controller.signal },
      );
      body = response.Body as Readable | undefined;
      controller.signal.throwIfAborted();
      if (response.Metadata?.[FENCE_METADATA] === FENCE_VERSION) return null;
      if (
        !body ||
        response.ContentLength === undefined ||
        !Number.isSafeInteger(response.ContentLength) ||
        response.ContentLength < 0 ||
        response.ContentLength > MAX_WORKSPACE_CIPHERTEXT_BYTES ||
        (options?.expectedBytes !== undefined && response.ContentLength !== options.expectedBytes)
      ) {
        throw new Error("invalid ciphertext length");
      }
      // A per-fragment array has unbounded overhead for tiny chunks even when
      // total bytes are bounded. Allocate only the validated length once.
      allocated = Buffer.alloc(response.ContentLength);
      let length = 0, fragments = 0;
      for await (const chunk of body) {
        controller.signal.throwIfAborted();
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > allocated.byteLength - length)
          throw new Error("ciphertext length exceeded");
        allocated.set(chunk, length);
        length += chunk.byteLength;
        if (++fragments % 64 === 0) await yieldToIo(undefined, { signal: controller.signal });
      }
      controller.signal.throwIfAborted();
      if (length !== response.ContentLength)
        throw new Error("incomplete ciphertext");
      const result = allocated;
      allocated = undefined;
      return result;
    } catch (error) {
      if (status(error) === 404) return null;
      // SDK errors can contain signed URLs or request metadata. Keep them out
      // of the API and worker error chains.
      throw new Error("workspace object download failed");
    } finally {
      clearTimeout(deadline);
      options?.signal?.removeEventListener("abort", abort);
      body?.destroy();
      allocated?.fill(0);
    }
  }

  /** All workspace keys are immutable; even ordinary removal permanently
   * retires the key so it cannot race and remove a deletion fence. */
  async delete(key: string): Promise<void> {
    await this.deleteAndFence(key);
  }

  async deleteAndFence(key: string): Promise<void> {
    assertCloudWorkspaceObjectKey(key);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: new Uint8Array(),
          ContentLength: 0,
          Metadata: { [FENCE_METADATA]: FENCE_VERSION },
          ContentType: "application/octet-stream",
          CacheControl: "no-store",
        }),
        { abortSignal: AbortSignal.timeout(OPERATION_TIMEOUT_MS) },
      );
    } catch {
      throw new Error("workspace object deletion failed");
    }
  }

  // Single bounded PUTs publish atomically and create no multipart/staging
  // objects. Failed database reservations use the durable deletion queue.
  async sweepAbandonedUploads(): Promise<number> {
    return 0;
  }
}
