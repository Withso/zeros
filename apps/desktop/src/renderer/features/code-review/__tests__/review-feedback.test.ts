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
beforeEach(() => status.mockReset().mockReturnValue(false));
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

it.each([false, true])("keeps unavailable workspace comments out of the content-error channel (managed: %s)", managed => {
  status.mockReturnValue(managed);
  const html = render({ loading: false, workspaceCommentsAvailable: false,
    notice: "Open the cloud workspace to view review comments." });
  expect(status).toHaveBeenCalledWith(expect.objectContaining({ error: null, pending: false }), "fixture");
  expect(html).toContain('role="status"');
  expect(html).toContain("Open the cloud workspace to view review comments.");
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("Retry comments");
});

it("keeps a public review read failure actionable beside a private-review availability notice", () => {
  const html = render({ loading: false, workspaceCommentsAvailable: false,
    notice: "Open the cloud workspace to view review comments.",
    external: { threads: [], error: new Error("Public review read failed") } });
  expect(status).toHaveBeenCalledWith(expect.objectContaining({ error: "Public review read failed" }), "fixture");
  expect(html).toContain("Public review read failed");
  expect(html).toContain("Open the cloud workspace to view review comments.");
});
