// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrCheck, PrChecksResult } from "../../../../platform/git";
import { ReviewChecksSection } from "../review-checks";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const check = (name: string, conclusion: string | null, extra: Partial<PrCheck> = {}): PrCheck => ({
  name,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  detailsUrl: null,
  startedAt: null,
  completedAt: null,
  ...extra,
} as PrCheck);

function result(checks: PrCheck[], expected?: Array<{ name: string }>): PrChecksResult {
  return {
    checks,
    deployments: [],
    total: checks.length,
    passed: 0,
    failed: 0,
    pending: 0,
    ...(expected ? { expected } : {}),
  };
}

async function render(data: PrChecksResult, onRerunFailed?: () => Promise<void>) {
  await act(async () =>
    root.render(
      createElement(ReviewChecksSection, {
        data,
        loading: false,
        error: null,
        prNumber: 7,
        branch: "topic",
        onAddToChat: () => {},
        onRetry: () => {},
        onRerunFailed,
      }),
    ),
  );
}

const rerunButton = () =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Re-run failed"));

describe("pull request checks", () => {
  it("marks the checks the base branch requires", async () => {
    await render(result([check("test", "failure", { required: true }), check("CodeRabbit", "failure")]));
    const badge = (name: string) =>
      host.querySelector(`[data-review-check="${name}"]`)?.textContent?.includes("Required");
    expect(badge("test")).toBe(true);
    expect(badge("CodeRabbit")).toBe(false);
  });

  it("lists required checks that haven't reported between Failed and Running", async () => {
    await render(
      result(
        [check("test", "failure"), check("build", null), check("lint", "success")],
        [{ name: "Preview deployment" }],
      ),
    );
    const groups = [...host.querySelectorAll("section[aria-label]")].map((section) => section.getAttribute("aria-label"));
    expect(groups).toEqual(["Failed checks", "Expected checks", "Running checks", "Passed checks"]);
    const expected = host.querySelector('[data-review-check-expected="Preview deployment"]');
    expect(expected?.textContent).toContain("Required");
    expect(expected?.textContent).toContain("Not reported yet");
    const counts = [...host.querySelectorAll("[data-review-checks-count]")].map((count) => count.textContent);
    expect(counts).toEqual(["1failed", "1running", "1expected", "1passed"]);
  });

  it("shows a branch whose required checks haven't started instead of No checks", async () => {
    await render(result([], [{ name: "test" }]));
    expect(host.textContent).not.toContain("No checks reported yet");
    expect(host.querySelector('[data-review-check-expected="test"]')).not.toBeNull();
    expect(host.querySelector('[data-review-checks-count="expected"]')?.textContent).toBe("1expected");
  });

  it("keeps No checks for a branch with nothing reported or required", async () => {
    await render(result([], []));
    expect(host.textContent).toContain("No checks reported yet");
  });

  it("offers Re-run failed only for failures it can restart", async () => {
    const onRerunFailed = vi.fn(async () => {});
    await render(result([check("CodeRabbit", "failure", { rerunnable: false })]), onRerunFailed);
    expect(rerunButton()).toBeUndefined();
    await render(result([check("test", "failure", { rerunnable: true })]));
    expect(rerunButton()).toBeUndefined();
    await render(result([check("test", "failure", { rerunnable: true })]), onRerunFailed);
    expect(rerunButton()).toBeDefined();
  });

  it("stays busy until the re-run settles", async () => {
    let settle!: () => void;
    const onRerunFailed = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    await render(result([check("test", "failure", { rerunnable: true })]), onRerunFailed);
    await act(async () => rerunButton()!.click());
    expect(onRerunFailed).toHaveBeenCalledTimes(1);
    expect(rerunButton()!.disabled).toBe(true);
    expect(rerunButton()!.getAttribute("aria-busy")).toBe("true");
    await act(async () => rerunButton()!.click());
    expect(onRerunFailed).toHaveBeenCalledTimes(1);
    await act(async () => settle());
    expect(rerunButton()!.disabled).toBe(false);
  });
});
