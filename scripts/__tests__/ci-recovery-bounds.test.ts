import { describe, expect, it } from "vitest";
import { createGitHubApi } from "../ci/recovery-api.mjs";
import { RecoveryController } from "../ci/recovery-controller.mjs";

const ancestor = "a".repeat(40);
const head = "b".repeat(40);

// GitHub lists changed files with patches only on the first compare page. A
// coalesced run spanning several merges made that page exceed the client's
// 2 MiB bound, which stopped every CI Recovery inspection.
function compareFetch(requests: string[]) {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    const filesPage = url.searchParams.get("page") !== "2";
    const body = JSON.stringify({
      status: "ahead",
      base_commit: { sha: ancestor },
      merge_base_commit: { sha: ancestor },
      files: filesPage ? [{ patch: "x".repeat(2 * 1024 * 1024 + 1) }] : [],
    });
    return new Response(body, {
      headers: { "content-type": "application/json" },
    });
  };
}

describe("recovery response bounds", () => {
  it("reads ancestry from a compare page without file patches", async () => {
    const requests: string[] = [];
    const readApi = createGitHubApi({
      token: "fixture",
      fetchImpl: compareFetch(requests) as typeof fetch,
    });
    const controller = new RecoveryController({ readApi });
    await expect(controller.ancestor(ancestor, head)).resolves.toBe(true);
    expect(requests).toEqual([
      `/repos/Withso/zeros/compare/${ancestor}...${head}?per_page=1&page=2`,
    ]);
  });

  it("lists pull requests in pages that stay within the response bound", async () => {
    // A page of 100 full pull requests reached 2,288,850 bytes once
    // descriptions grew; incident discovery needs only number and head ref.
    const requests: string[] = [];
    const pull = (number: number) => ({
      number,
      head: { ref: "feature/" + number },
      body: "x".repeat(60_000),
    });
    const readApi = createGitHubApi({
      token: "fixture",
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requests.push(url.pathname + url.search);
        const page = Number(url.searchParams.get("page"));
        const size = Number(url.searchParams.get("per_page"));
        const total = 65;
        const rows = Array.from(
          { length: Math.max(0, Math.min(size, total - (page - 1) * size)) },
          (_, index) => pull((page - 1) * size + index + 1),
        );
        return new Response(JSON.stringify(rows), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    const controller = new RecoveryController({ readApi });
    await expect(controller.incidents({})).resolves.toEqual([]);
    expect(requests).toEqual(
      [1, 2, 3].map(
        (page) =>
          `/repos/Withso/zeros/pulls?state=all&sort=created&direction=desc&per_page=30&page=${page}`,
      ),
    );
  });
});
