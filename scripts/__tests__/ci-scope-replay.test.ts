import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createLedger, decideScope, loadPolicy } from "../ci/scope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLICY = loadPolicy(path.join(HERE, "../ci/scope-rules.json"));
const prs: Array<{
  number: number;
  files: Array<{ filename: string; status: string }>;
}> = JSON.parse(
  readFileSync(path.join(HERE, "fixtures/ci/merged-prs-60.json"), "utf8"),
);
const expected = JSON.parse(
  readFileSync(path.join(HERE, "fixtures/ci/merged-prs-60-lanes.json"), "utf8"),
);
const statuses: Record<string, string> = {
  added: "A",
  modified: "M",
  removed: "D",
};
const replay = prs.map((pr) => ({
  number: pr.number,
  decision: decideScope({
    policy: POLICY,
    changes: pr.files.map((file) => ({
      path: file.filename,
      status: statuses[file.status],
    })),
  }),
}));

describe("CI scope merged-PR replay", () => {
  it("avoids all-lanes fallback for at least half the surviving research surface", () => {
    expect(prs).toHaveLength(60);
    // The historical fixture includes cloud paths retired in v2. Reintroducing
    // those paths correctly fails closed; they no longer measure selection
    // efficiency for the current tree. Their full decisions remain pinned below.
    const retiredRoots = ["docs/cloud-workspace/", "scripts/cloud-workspace-validation/",
      "scripts/runtime-skew/", "scripts/zeros-dev/", "packages/cloud-client/"];
    const current = new Set(prs.filter(pr => !pr.files.some(file =>
      retiredRoots.some(root => file.filename.startsWith(root)))).map(pr => pr.number));
    const currentReplay = replay.filter(({ number }) => current.has(number));
    expect(currentReplay.length).toBeGreaterThanOrEqual(20);
    expect(currentReplay.filter(({ decision }) => !decision.full).length)
      .toBeGreaterThanOrEqual(Math.ceil(currentReplay.length / 2));
    expect(replay.filter(({ decision }) => decision.lanes["ui-smoke"])).toEqual(
      [],
    );
  });

  it("pins the fallback decision and lane set of every sampled PR", () => {
    const actual = Object.fromEntries(
      replay.map(({ number, decision }) => [
        String(number),
        {
          full: decision.full,
          lanes: Object.keys(decision.lanes)
            .filter((lane) => decision.lanes[lane])
            .sort(),
          jobs: Object.entries(
            createLedger({
              policy: POLICY,
              decision,
              event: "pull_request",
              mode: "pr",
            }).jobs ?? {},
          )
            .filter(([, run]) => run)
            .map(([id]) => id)
            .sort(),
        },
      ]),
    );
    expect(actual).toEqual(expected);
  });
});
