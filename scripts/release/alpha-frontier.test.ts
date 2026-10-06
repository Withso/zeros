import { describe, expect, it, vi } from "vitest";
import { alphaAncestor, alphaAncestry } from "./alpha-frontier";
import { PromotionError } from "./contracts";
import { jsonClient } from "./io";

const base = "a".repeat(40), head = "b".repeat(40);
describe("Alpha GitHub ancestry comparison", () => {
  it.each(["identical", "ahead", "behind", "diverged"])("handles %s without inferring ancestry from timestamps", async status => {
    const target = status === "identical" ? base : head;
    const read = vi.fn(async () => ({ status, base_commit: { sha: base },
      merge_base_commit: { sha: status === "diverged" ? "c".repeat(40) : base } }));
    await expect(alphaAncestor(base, target, read)).resolves.toBe(status === "identical" || status === "ahead");
    expect(read).toHaveBeenCalledExactlyOnceWith(`/compare/${base}...${target}?per_page=1&page=2`);
  });
  it("reads ancestry from a comparison page without file patches", async () => {
    // GitHub returns changed files (with patches) only on the first compare page.
    // A distant live destination made that page exceed the 2 MiB JSON client cap.
    const patches = "x".repeat(2 * 1024 * 1024 + 1);
    const routed = jsonClient(async (url) => new Response(JSON.stringify(new URL(String(url)).searchParams.get("page") === "2"
      ? { status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: base }, files: [] }
      : { status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: base }, files: [{ patch: patches }] })),
    async () => {});
    await expect(alphaAncestor(base, head, (route) => routed(`https://api.github.com/repos/o/r${route}`))).resolves.toBe(true);
  });
  it.each([
    null, {}, { status: "unknown" }, { status: "ahead", base_commit: { sha: head }, merge_base_commit: { sha: base } },
    { status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: head } },
    { status: "identical", base_commit: { sha: base }, merge_base_commit: { sha: base } },
    { status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: "invalid" } },
  ])("fails closed on absent, malformed or contradictory comparison %#", async value => {
    await expect(alphaAncestor(base, head, async () => value)).rejects.toBeInstanceOf(PromotionError);
  });
  it("turns private request errors into a fixed policy error", async () => {
    const read = async () => { throw new Error("private synthetic response"); };
    await expect(alphaAncestor(base, head, read)).rejects.toThrow("Alpha ancestry comparison is unavailable");
  });
  it("rejects invalid source identities without issuing requests", async () => {
    const read = vi.fn();
    await expect(alphaAncestor("invalid", head, read)).rejects.toThrow("source is invalid");
    expect(read).not.toHaveBeenCalled();
  });
  it("deduplicates only within a checkpoint and re-reads at the next checkpoint", async () => {
    const read = vi.fn(async () => ({ status: "ahead", base_commit: { sha: base }, merge_base_commit: { sha: base } }));
    const checkpoint = alphaAncestry(read);
    await Promise.all([checkpoint(base, head), checkpoint(base, head)]);
    expect(read).toHaveBeenCalledOnce();
    await alphaAncestry(read)(base, head);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
