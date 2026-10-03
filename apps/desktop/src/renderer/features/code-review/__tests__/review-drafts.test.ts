import { describe, expect, it } from "vitest";
import { ReviewDraftStore } from "../review-draft-store";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("inline review drafts", () => {
  it("locks duplicate submits synchronously and retains text typed during submission", async () => {
    const store = new ReviewDraftStore();
    const pending = deferred();
    store.setBody("new:a", "First comment");
    const first = store.submit("new:a", () => pending.promise);
    expect(store.getSnapshot("new:a").busy).toBe(true);
    expect(
      await store.submit("new:a", async () => {
        throw new Error("duplicate");
      }),
    ).toBe("busy");
    store.setBody("new:a", "Next comment");
    pending.resolve();
    expect(await first).toBe("retained");
    expect(store.getSnapshot("new:a")).toMatchObject({
      body: "Next comment",
      busy: false,
      error: null,
    });
  });

  it("keeps errors/drafts across slot remounts and retries the same request id", async () => {
    const store = new ReviewDraftStore();
    const ids: string[] = [];
    const stop = store.subscribe("reply:thread", () => {});
    store.setBody("reply:thread", "Please check this.");
    expect(
      await store.submit("reply:thread", async (_body, id) => {
        ids.push(id);
        throw new Error("Offline");
      }),
    ).toBe("error");
    stop();
    expect(store.getSnapshot("reply:thread")).toMatchObject({
      body: "Please check this.",
      error: "Offline",
    });
    expect(
      await store.submit("reply:thread", async (_body, id) => {
        ids.push(id);
      }),
    ).toBe("submitted");
    expect(ids[0]).toBe(ids[1]);
    expect(store.getSnapshot("reply:thread").body).toBe("");
  });

  it("isolates range/thread drafts and bounds inactive records", () => {
    const store = new ReviewDraftStore(2);
    store.setBody("a", "A");
    store.setBody("b", "B");
    store.setBody("c", "C");
    expect(store.size).toBe(2);
    expect(store.getSnapshot("b").body).toBe("B");
    expect(store.getSnapshot("c").body).toBe("C");
  });
});
