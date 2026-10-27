import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ReviewFeedback } from "../review-feedback";
import { ReviewDraftStore } from "../review-draft-store";
import type { CodeReviewController } from "../use-code-review";

const status = vi.hoisted(() => vi.fn(() => false));
vi.mock("../../../shell/workbench/tab-status", () => ({ useWorkbenchStatusSource: status }));
const review: CodeReviewController = {
  ownerKey: "fixture", threads: [], drafts: new ReviewDraftStore(), loading: true, error: null, refresh: vi.fn(),
  operations: { create: async () => {}, reply: async () => {}, setResolved: async () => {} },
};
beforeEach(() => status.mockClear());
const render = (patch: Partial<CodeReviewController> = {}) => renderToStaticMarkup(createElement(ReviewFeedback, { review: { ...review, ...patch } }));

it.each([false, true])("renders no loading text or padded wrapper while review is pending (external: %s)", external => {
  const html = render(external ? { loading: false, external: { threads: [], loading: true } } : {});
  expect(html).not.toContain("Loading comments");
  expect(html).not.toContain("data-review-feedback");
  expect(html).toBe("");
  expect(status).toHaveBeenCalledWith(expect.objectContaining({ pending: true }), "fixture");
});

it("keeps errors, notices and pagination while refreshing without adding a loading row", () => {
  const html = render({ error: new Error("Read failed"), external: { threads: [], notice: "More on GitHub" }, partial: true,
    nextCursor: "next", loadMore: async () => {} });
  expect(html).toContain("Read failed"); expect(html).toContain("Retry comments");
  expect(html).toContain("More on GitHub"); expect(html).toContain("Load more discussions");
  expect(html).not.toContain("Loading comments");
});
