import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { updateMainRed } from "../ci/main-red.mjs";

const RED_SHA = "a".repeat(40), NEXT_SHA = "b".repeat(40), OLD_SHA = "c".repeat(40);
const run = (patch: Record<string, unknown> = {}) => ({ id: 7, head_sha: RED_SHA, conclusion: "failure", event: "push",
  head_branch: "main", html_url: "https://github.com/Withso/zeros/actions/runs/7", ...patch });

function fakeApi(issues: any[] = [], compare: Record<string, string> = {}) {
  const writes: [string, string, any][] = [];
  const api = async (method: string, route: string, body?: any) => {
    if (method !== "GET") { writes.push([method, route, body]); return method === "POST" && route === "/issues" ? { number: 55 } : {}; }
    if (route.startsWith("/issues?")) return issues;
    if (route.startsWith("/actions/runs/7/jobs")) return { jobs: [
      { name: "tests-ui-smoke (2/3)", conclusion: "failure", html_url: "https://github.com/x/job/1" },
      { name: "build", conclusion: "success", html_url: "https://github.com/x/job/2" }] };
    if (route.startsWith("/compare/")) return { status: compare[route] ?? "behind" };
    throw new Error(`unexpected ${route}`);
  };
  return { api, writes };
}
const openIssue = (sha: string) => ({ number: 42, title: `main is red at ${sha.slice(0, 12)}`, body: `<!-- main-red-sha: ${sha} -->\nold` });

describe("main red alert", () => {
  it("opens one issue naming the commit and its failed jobs", async () => {
    const { api, writes } = fakeApi();
    expect(await updateMainRed({ api, run: run(), log: () => {} })).toBe("opened");
    expect(writes).toHaveLength(1);
    const [method, route, body] = writes[0];
    expect([method, route]).toEqual(["POST", "/issues"]);
    expect(body.title).toBe(`main is red at ${RED_SHA.slice(0, 12)}`);
    expect(body.body).toContain("tests-ui-smoke (2/3)");
    expect(body.body).not.toContain("[build]");
  });

  it("refreshes the existing issue for a newer red commit instead of opening another", async () => {
    const { api, writes } = fakeApi([openIssue(RED_SHA)], { [`/compare/${RED_SHA}...${NEXT_SHA}`]: "ahead" });
    expect(await updateMainRed({ api, run: run({ head_sha: NEXT_SHA }), log: () => {} })).toBe("refreshed");
    expect(writes).toEqual([["PATCH", "/issues/42", expect.objectContaining({ title: `main is red at ${NEXT_SHA.slice(0, 12)}` })]]);
  });

  it("closes the issue on a green push at or after the red commit", async () => {
    const { api, writes } = fakeApi([openIssue(RED_SHA)], { [`/compare/${RED_SHA}...${NEXT_SHA}`]: "ahead" });
    expect(await updateMainRed({ api, run: run({ head_sha: NEXT_SHA, conclusion: "success" }), log: () => {} })).toBe("closed");
    expect(writes.at(-1)).toEqual(["PATCH", "/issues/42", { state: "closed", state_reason: "completed" }]);
  });

  it("ignores an older commit's green or red run that finishes late", async () => {
    for (const conclusion of ["success", "failure"]) {
      const { api, writes } = fakeApi([openIssue(RED_SHA)], { [`/compare/${RED_SHA}...${OLD_SHA}`]: "behind" });
      expect(await updateMainRed({ api, run: run({ head_sha: OLD_SHA, conclusion }), log: () => {} })).toMatch(/^older-/);
      expect(writes).toEqual([]);
    }
  });

  it.each([{ event: "pull_request" }, { head_branch: "release/1.2.3" }, { conclusion: "cancelled" }])("leaves issues alone for %j", async (patch) => {
    const { api, writes } = fakeApi([openIssue(RED_SHA)]);
    await updateMainRed({ api, run: run(patch), log: () => {} });
    expect(writes).toEqual([]);
  });

  it("runs from the default branch after Preflight with least permissions and no PR access", () => {
    const workflow = load(readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows/main-red.yml"), "utf8")) as any;
    expect(workflow.on).toEqual({ workflow_run: { workflows: ["Preflight"], types: ["completed"], branches: ["main"] } });
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.alert.permissions).toEqual({ actions: "read", contents: "read", issues: "write" });
    expect(workflow.jobs.alert.if).toContain("workflow_run.event == 'push'");
  });
});
