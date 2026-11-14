import { describe, expect, it, vi } from "vitest";
import { retireLegacyCloudTranscriptStore } from "../cloud-chat-cache";

describe("legacy cloud transcript database retirement", () => {
  it("deletes only the cloud transcript namespace and joins concurrent callers", async () => {
    const request = {} as IDBOpenDBRequest;
    const deleteDatabase = vi.fn(() => request);
    const factory = { deleteDatabase } as unknown as IDBFactory;
    const first = retireLegacyCloudTranscriptStore(factory), second = retireLegacyCloudTranscriptStore(factory);
    await vi.waitFor(() => expect(deleteDatabase).toHaveBeenCalledOnce());
    expect(deleteDatabase).toHaveBeenCalledWith("zeros:cloud-transcripts:v1");
    request.onsuccess?.(new Event("success"));
    await first; await second;
    await retireLegacyCloudTranscriptStore(factory);
    expect(deleteDatabase).toHaveBeenCalledOnce();
  });
  it("leaves a failed migration retryable without blocking the native cache", async () => {
    const request = {} as IDBOpenDBRequest;
    const deleteDatabase = vi.fn(() => request);
    const factory = { deleteDatabase } as unknown as IDBFactory;
    const first = retireLegacyCloudTranscriptStore(factory);
    await vi.waitFor(() => expect(deleteDatabase).toHaveBeenCalledOnce());
    request.onerror?.(new Event("error")); await first;
    const second = retireLegacyCloudTranscriptStore(factory);
    await vi.waitFor(() => expect(deleteDatabase).toHaveBeenCalledTimes(2));
    request.onsuccess?.(new Event("success")); await second;
  });
});
