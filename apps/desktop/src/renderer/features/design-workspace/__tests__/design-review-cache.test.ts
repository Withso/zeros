import { beforeEach, expect, it, vi } from "vitest";
import type { DesignReviewSnapshot } from "@zeros/protocol/design-review";
import {
  designReviewCache,
  designReviewDetailCache,
  designReviewEvidenceCache,
  invalidateDesignReviewCache,
} from "../../../state/read-caches";
import {
  designReviewKey,
  fetchDesignReview,
  warmDesignReviewDetail,
} from "../state/design-review-cache";
const bridge = vi.hoisted(() => ({ snapshot: vi.fn(), file: vi.fn(), operation: vi.fn() }));
vi.mock("../../../platform/bridge/design-review-bridge", () => ({
  readDesignReview: bridge.snapshot,
  designReviewOperation: bridge.operation,
  readDesignReviewFile: bridge.file,
  readDesignProposalReview: vi.fn(),
}));
const sample = (owner: string): DesignReviewSnapshot => ({
  directory: owner,
  directoryId: owner,
  indexFingerprint: "a".repeat(64),
  scope: "uncommitted",
  counts: { all: 0, uncommitted: 0, staged: 0, unstaged: 0, proposals: 0 },
  files: [],
  proposals: [],
  nextOffset: null,
  conflict: false,
});
beforeEach(() => {
  designReviewCache.clear();
  designReviewDetailCache.clear();
  designReviewEvidenceCache.clear();
  vi.clearAllMocks();
});
it("deduplicates exact keys, restores A after B, and retains its confirmed rows during refresh", async () => {
  let finish!: (value: DesignReviewSnapshot) => void;
  bridge.snapshot.mockImplementation((owner: string) =>
    owner === "A"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(sample(owner)),
  );
  const a = designReviewKey("A"),
    b = designReviewKey("B");
  const first = designReviewCache.load(a, () => fetchDesignReview(a));
  const duplicate = designReviewCache.load(a, () => fetchDesignReview(a));
  await designReviewCache.load(b, () => fetchDesignReview(b));
  expect(bridge.snapshot).toHaveBeenCalledTimes(2);
  finish(sample("A"));
  await Promise.all([first, duplicate]);
  const confirmed = designReviewCache.peekSnapshot(a).data;
  expect(confirmed?.directory).toBe("A");
  invalidateDesignReviewCache("A");
  expect(designReviewCache.peekSnapshot(a).data).toBe(confirmed);
  const refresh = designReviewCache.load(a, () => fetchDesignReview(a), {
    force: true,
  });
  expect(designReviewCache.peekSnapshot(a).data).toBe(confirmed);
  expect(designReviewCache.peekSnapshot(b).data?.directory).toBe("B");
  await vi.waitFor(() => expect(bridge.snapshot).toHaveBeenCalledTimes(3));
  finish(sample("A"));
  await refresh;
  expect(designReviewCache.peekSnapshot(a).data).toBe(confirmed);
});
it("bounds speculative detail reads and retained snapshots", async () => {
  const releases: Array<() => void> = [];
  bridge.file.mockImplementation(
    () =>
      new Promise((resolve) => {
        releases.push(() =>
          resolve({
            path: "frame.html",
            patch: "",
            binary: false,
            truncated: false,
          }),
        );
      }),
  );
  for (let i = 0; i < 20; i++)
    warmDesignReviewDetail(
      JSON.stringify(["owner", "directory", "staged", `frame-${i}.html`]),
    );
  await vi.waitFor(() => expect(bridge.file).toHaveBeenCalledTimes(2));
  releases.forEach((release) => release());
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 40; i++)
    designReviewCache.setData(designReviewKey(String(i)), sample(String(i)));
  expect(designReviewCache.keys().length).toBeLessThanOrEqual(32);
  expect(
    designReviewCache.peekSnapshot(designReviewKey("0")).data,
  ).toBeUndefined();
  expect(
    designReviewCache.peekSnapshot(designReviewKey("39")).data?.directory,
  ).toBe("39");
});
