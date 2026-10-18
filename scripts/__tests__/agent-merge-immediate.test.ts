import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { runAgentMerge } from "../agent-merge.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "c".repeat(40);

function fixture() {
  return {
    viewer: { login: "workspace-owner", type: "User" },
    pr: {
      id: "PR_fixture",
      number: 123,
      title: "Fix navigation `literal` $(literal)",
      body: 'Preserve the workspace.\n\nLiteral "text".',
      state: "OPEN",
      isDraft: false,
      isCrossRepository: false,
      headRefOid: HEAD,
      baseRefOid: BASE,
      baseRefName: "main",
      changedFiles: 1,
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null as string | null,
      autoMergeRequest: null as { enabledAt: string } | null,
      isInMergeQueue: false,
      viewerCanMergeAsAdmin: false,
    },
    files: [{ filename: "docs/navigation.md", status: "modified" }],
    requiredChecks: [{ name: "test", bucket: "pass", state: "SUCCESS" }],
    checks: [
      { name: "test", bucket: "pass", state: "SUCCESS" },
      { name: "optional", bucket: "skipping", state: "SKIPPED" },
    ],
    openPullRequests: [
      {
        number: 123,
        autoMergeRequest: null as { enabledAt: string } | null,
        isInMergeQueue: false,
      },
    ],
    mergeQueue: null as { id: string } | null,
  };
}

type Snapshot = ReturnType<typeof fixture>;
type Response = { status: number; stdout: string; stderr: string };

function json(value: unknown, status = 0): Response {
  return { status, stdout: JSON.stringify(value), stderr: "" };
}

function fakeGh(snapshot = fixture()) {
  const calls: string[][] = [];
  const writes: { query: string; variables: Record<string, unknown> }[] = [];
  let prReads = 0;
  let openReads = 0;
  const controls = {
    beforePrRead: (_read: number, _snapshot: Snapshot) => {},
    beforeOpenRead: (_read: number, _snapshot: Snapshot) => {},
    mergeResponse: null as Response | null,
    badReadback: false,
  };
  const spawn = vi.fn((_command: string, args: string[], _options: unknown) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "user") return json(snapshot.viewer);
    if (args[0] === "pr" && args[1] === "checks")
      return json(
        args.includes("--required") ? snapshot.requiredChecks : snapshot.checks,
      );
    if (args[0] === "api" && args[1].includes("/files?"))
      return json([snapshot.files]);
    if (
      args[0] === "api" &&
      args[1].includes("/actions/workflows/zeros-dev-e2e.yml/runs")
    )
      return json({ total_count: 0, workflow_runs: [] });
    if (args[0] === "api" && args[1] === "graphql") {
      if (args.includes("--input")) {
        const payload = JSON.parse(
          readFileSync(args[args.indexOf("--input") + 1], "utf8"),
        );
        writes.push(payload);
        if (controls.mergeResponse) return controls.mergeResponse;
        return json({
          data: { mergePullRequest: { pullRequest: mergedPr() } },
        });
      }
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      if (query.includes("ImmediateMergePreflight")) {
        controls.beforePrRead(++prReads, snapshot);
        return json({ data: { repository: { pullRequest: snapshot.pr } } });
      }
      if (query.includes("ImmediateMergeQueue"))
        return json({
          data: { repository: { mergeQueue: snapshot.mergeQueue } },
        });
      if (query.includes("ImmediateMergeResult"))
        return json({
          data: {
            repository: {
              pullRequest: controls.badReadback ? snapshot.pr : mergedPr(),
            },
          },
        });
      controls.beforeOpenRead(++openReads, snapshot);
      return json([
        {
          data: {
            repository: {
              pullRequests: {
                nodes: snapshot.openPullRequests,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ]);
    }
    throw new Error("Unexpected gh invocation");
  });
  function mergedPr() {
    return {
      ...snapshot.pr,
      state: "MERGED",
      merged: true,
      mergeCommit: { oid: MERGE },
    };
  }
  return {
    calls,
    writes,
    controls,
    spawn,
    stdout: vi.fn(),
    stderr: vi.fn(),
    loadCiDefinition: vi.fn(
      async () => (file: string) =>
        file.startsWith("scripts/ci/") || file.startsWith(".github/workflows/"),
    ),
  };
}

function expectNoWrite(gh: ReturnType<typeof fakeGh>) {
  expect(gh.writes).toEqual([]);
  expect(gh.calls.some((args) => args[0] === "pr" && args[1] === "merge")).toBe(
    false,
  );
}

describe("immediate-only agent merge", () => {
  it.each([
    "docs/navigation.md",
    "apps/control-plane/src/cloud-workspaces/routes.ts",
  ])(
    "merges exactly once with a server expected-head guard and confirmed SHA for %s",
    async (filename) => {
      const snapshot = fixture();
      snapshot.files[0].filename = filename;
      const gh = fakeGh(snapshot);
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(0);
      expect(gh.writes).toHaveLength(1);
      expect(gh.writes[0].query).toContain("mergePullRequest(input: $input)");
      expect(gh.writes[0].variables).toEqual({
        input: {
          pullRequestId: snapshot.pr.id,
          expectedHeadOid: HEAD,
          mergeMethod: "SQUASH",
          commitHeadline: `${snapshot.pr.title} (#123)`,
          commitBody: snapshot.pr.body,
        },
      });
      expect(gh.stdout).toHaveBeenCalledWith(
        expect.stringContaining(
          `Merged PR #123 at ${HEAD} into main; merge commit ${MERGE}.`,
        ),
      );
      const requestFile = gh.calls.find((args) => args.includes("--input"))!;
      expect(existsSync(requestFile[requestFile.indexOf("--input") + 1])).toBe(
        false,
      );
      for (const call of gh.spawn.mock.calls) {
        expect(call[0]).toBe("gh");
        expect(call[2]).toMatchObject({ shell: false, stdio: "pipe" });
        expect(call[2]).not.toHaveProperty("env");
      }
      expect(JSON.stringify(gh.writes)).not.toMatch(
        /enablePullRequestAutoMerge|enqueuePullRequest|dequeuePullRequest|disablePullRequestAutoMerge/,
      );
      expect(
        gh.calls.some((args) => args[0] === "pr" && args[1] === "merge"),
      ).toBe(false);
    },
  );

  it("dry-runs the immediate mode truthfully with no mutation", async () => {
    const gh = fakeGh();
    expect(await runAgentMerge(["--immediate", "--dry-run", "123"], gh)).toBe(
      0,
    );
    expect(gh.stdout).toHaveBeenCalledWith(
      expect.stringContaining("Dry run: Merge immediately"),
    );
    expect(gh.stdout).toHaveBeenCalledWith(
      expect.stringContaining(`expectedHeadOid=${HEAD}`),
    );
    expect(JSON.stringify(gh.stdout.mock.calls)).not.toMatch(
      /--auto|Arm auto-merge/,
    );
    expectNoWrite(gh);
  });

  it.each([
    ["pending", "IN_PROGRESS"],
    ["fail", "FAILURE"],
    ["cancel", "CANCELLED"],
    ["unknown", "UNKNOWN"],
    ["pass", "UNKNOWN"],
    ["skipping", "SKIPPED"],
  ])("refuses required CI %s/%s", async (bucket, state) => {
    const snapshot = fixture();
    snapshot.requiredChecks[0] = { name: "test", bucket, state };
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
  });

  it.each(["requiredChecks", "checks"] as const)(
    "refuses missing %s",
    async (key) => {
      const snapshot = fixture();
      snapshot[key] = [];
      const gh = fakeGh(snapshot);
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it.each([
    ["pending", "QUEUED"],
    ["fail", "FAILURE"],
    ["pass", "UNKNOWN"],
  ])("refuses unsafe optional CI %s/%s", async (bucket, state) => {
    const snapshot = fixture();
    snapshot.checks[1] = { name: "optional", bucket, state };
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
  });

  const unsafe: [string, (s: Snapshot) => void][] = [
    [
      "missing required review",
      (s) => {
        s.pr.reviewDecision = "REVIEW_REQUIRED";
      },
    ],
    [
      "changes requested",
      (s) => {
        s.pr.reviewDecision = "CHANGES_REQUESTED";
      },
    ],
    [
      "unknown review",
      (s) => {
        s.pr.reviewDecision = "UNKNOWN";
      },
    ],
    [
      "unknown mergeability",
      (s) => {
        s.pr.mergeable = "UNKNOWN";
      },
    ],
    [
      "conflicts",
      (s) => {
        s.pr.mergeable = "CONFLICTING";
      },
    ],
    [
      "behind base",
      (s) => {
        s.pr.mergeStateStatus = "BEHIND";
      },
    ],
    [
      "blocked",
      (s) => {
        s.pr.mergeStateStatus = "BLOCKED";
      },
    ],
    [
      "unstable",
      (s) => {
        s.pr.mergeStateStatus = "UNSTABLE";
      },
    ],
    [
      "draft",
      (s) => {
        s.pr.isDraft = true;
      },
    ],
    [
      "closed",
      (s) => {
        s.pr.state = "CLOSED";
      },
    ],
    [
      "fork",
      (s) => {
        s.pr.isCrossRepository = true;
      },
    ],
    [
      "skip marker",
      (s) => {
        s.pr.body += " [skip ci]";
      },
    ],
    [
      "bot identity",
      (s) => {
        s.viewer.type = "Bot";
      },
    ],
    [
      "admin bypass",
      (s) => {
        s.pr.viewerCanMergeAsAdmin = true;
      },
    ],
    [
      "merge-queue branch",
      (s) => {
        s.mergeQueue = { id: "MQ_fixture" };
      },
    ],
    [
      "target queued",
      (s) => {
        s.pr.isInMergeQueue = true;
      },
    ],
    [
      "target auto-armed",
      (s) => {
        s.pr.autoMergeRequest = { enabledAt: "2026-10-18T00:00:00Z" };
      },
    ],
    [
      "target auto-armed in open list",
      (s) => {
        s.openPullRequests[0].autoMergeRequest = {
          enabledAt: "2026-10-18T00:00:00Z",
        };
      },
    ],
    [
      "another queued PR",
      (s) => {
        s.openPullRequests.push({
          number: 124,
          isInMergeQueue: true,
          autoMergeRequest: null,
        });
      },
    ],
    [
      "another armed PR",
      (s) => {
        s.openPullRequests.push({
          number: 124,
          isInMergeQueue: false,
          autoMergeRequest: { enabledAt: "2026-10-18T00:00:00Z" },
        });
      },
    ],
    [
      "CI definition",
      (s) => {
        s.files[0].filename = "scripts/ci/scope.mjs";
      },
    ],
    [
      "CI policy itself",
      (s) => {
        s.files[0].filename = "scripts/ci/ci-definition.mjs";
      },
    ],
    [
      "workflow",
      (s) => {
        s.files[0].filename = ".github/workflows/ci.yml";
      },
    ],
    [
      "incident",
      (s) => {
        s.files[0].filename = ".github/ci-incidents/repair.json";
      },
    ],
    [
      "malformed base",
      (s) => {
        s.pr.baseRefOid = "";
      },
    ],
    [
      "malformed head",
      (s) => {
        s.pr.headRefOid = "";
      },
    ],
  ];

  it.each(unsafe)(
    "refuses %s without a merge side effect",
    async (_label, change) => {
      const snapshot = fixture();
      change(snapshot);
      const gh = fakeGh(snapshot);
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it.each([
    [
      "head",
      (s: Snapshot) => {
        s.pr.headRefOid = "d".repeat(40);
      },
    ],
    [
      "base commit",
      (s: Snapshot) => {
        s.pr.baseRefOid = "d".repeat(40);
      },
    ],
    [
      "base branch",
      (s: Snapshot) => {
        s.pr.baseRefName = "release/1.0";
      },
    ],
    [
      "title",
      (s: Snapshot) => {
        s.pr.title = "Another title";
      },
    ],
    [
      "body",
      (s: Snapshot) => {
        s.pr.body = "Another body";
      },
    ],
    ...unsafe,
  ])("fences a %s race across preflight reads", async (_label, change) => {
    const gh = fakeGh();
    gh.controls.beforePrRead = (read, snapshot) => {
      if (read === 2) change(snapshot);
    };
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
  });

  it("refreshes the one-armed guard before mutation", async () => {
    const gh = fakeGh();
    gh.controls.beforeOpenRead = (read, snapshot) => {
      if (read === 2)
        snapshot.openPullRequests.push({
          number: 124,
          isInMergeQueue: false,
          autoMergeRequest: { enabledAt: "2026-10-18T00:00:00Z" },
        });
    };
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
  });

  it("accepts policy-qualified approval without inventing a writer-approval requirement", async () => {
    const snapshot = fixture();
    snapshot.pr.reviewDecision = "APPROVED";
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(0);
    expect(gh.writes).toHaveLength(1);
  });

  it("allows a completed neutral optional check without treating a neutral required check as success", async () => {
    const snapshot = fixture();
    snapshot.checks[1] = { name: "optional", bucket: "pass", state: "NEUTRAL" };
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(0);
    expect(gh.writes).toHaveLength(1);
    snapshot.requiredChecks[0].state = "NEUTRAL";
    const required = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], required)).toBe(1);
    expectNoWrite(required);
  });

  it("preserves the PR's existing branch-based stack destination without retargeting", async () => {
    const snapshot = fixture();
    snapshot.pr.baseRefName = "feature/parent";
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(0);
    expect(
      gh.calls.filter((args) => args.some((arg) => arg.startsWith("branch="))),
    ).toHaveLength(2);
    expect(gh.calls.flat()).toContain("branch=feature/parent");
    expect(gh.stdout).toHaveBeenCalledWith(
      expect.stringContaining("into feature/parent; merge commit"),
    );
    expect(gh.writes).toHaveLength(1);
  });

  it.each([
    "isInMergeQueue",
    "autoMergeRequest",
    "reviewDecision",
    "viewerCanMergeAsAdmin",
    "baseRefOid",
    "id",
  ])("refuses missing safety metadata: %s", async (field) => {
    const snapshot = fixture();
    Reflect.deleteProperty(snapshot.pr, field);
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
  });

  it("refuses incomplete label and queue observations", async () => {
    const snapshot = fixture();
    snapshot.pr.labels.pageInfo.hasNextPage = true;
    const labels = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], labels)).toBe(1);
    expectNoWrite(labels);
    snapshot.pr.labels.pageInfo.hasNextPage = false;
    Reflect.deleteProperty(snapshot, "mergeQueue");
    const queue = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], queue)).toBe(1);
    expectNoWrite(queue);
  });

  it("retains fail-closed shared-policy loading in immediate mode", async () => {
    const gh = fakeGh();
    gh.loadCiDefinition.mockRejectedValue(new Error("private-output-fixture"));
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
    expect(JSON.stringify(gh.stderr.mock.calls)).not.toContain(
      "private-output-fixture",
    );
  });

  it.each([2, 3, 4, 5])(
    "refuses a changed head at preflight read %s",
    async (readToChange) => {
      const gh = fakeGh();
      gh.controls.beforePrRead = (read, snapshot) => {
        if (read === readToChange) snapshot.pr.headRefOid = "d".repeat(40);
      };
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it.each([
    "expected-head mismatch",
    "base policy change",
    "required check failure",
    "review revoked",
    "queue enabled",
  ])(
    "leaves no scheduled work when the server refuses a late %s race",
    async (reason) => {
      const gh = fakeGh();
      gh.controls.mergeResponse = json({ errors: [{ message: reason }] }, 1);
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expect(gh.writes).toHaveLength(1);
      expect(gh.writes[0].variables).toMatchObject({
        input: { expectedHeadOid: HEAD },
      });
      expect(gh.writes[0].query).not.toMatch(
        /enablePullRequestAutoMerge|enqueuePullRequest|dequeuePullRequest|disablePullRequestAutoMerge/,
      );
      expect(JSON.stringify(gh.stdout.mock.calls)).not.toContain("Merged PR");
    },
  );

  it.each([
    json({
      errors: [{ message: "private-output-fixture" }],
      data: { mergePullRequest: null },
    }),
    json({
      data: {
        mergePullRequest: { pullRequest: { state: "OPEN", merged: false } },
      },
    }),
    {
      status: 1,
      stdout: "private-output-fixture",
      stderr: "private-output-fixture",
    },
    json({}),
  ])(
    "does not retry, schedule or report success after a refused/unknown server result",
    async (response) => {
      const gh = fakeGh();
      gh.controls.mergeResponse = response;
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expect(gh.writes).toHaveLength(1);
      expect(
        JSON.stringify([...gh.stdout.mock.calls, ...gh.stderr.mock.calls]),
      ).not.toContain("private-output-fixture");
      expect(JSON.stringify(gh.stdout.mock.calls)).not.toContain("Merged PR");
    },
  );

  it("does not call an accepted request success until readback confirms the merged result", async () => {
    const gh = fakeGh();
    gh.controls.badReadback = true;
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expect(gh.writes).toHaveLength(1);
    expect(JSON.stringify(gh.stdout.mock.calls)).not.toContain("Merged PR");
  });

  it.each([
    { id: "PR_other" },
    { number: 124 },
    { headRefOid: "d".repeat(40) },
    { baseRefName: "elsewhere" },
    { state: "OPEN" },
    { merged: false },
    { mergeCommit: null },
    { mergeCommit: { oid: "invalid" } },
    { autoMergeRequest: { enabledAt: "2026-10-18T00:00:00Z" } },
    { isInMergeQueue: true },
  ])(
    "never reports success for a mismatched merged receipt: %j",
    async (patch) => {
      const snapshot = fixture();
      const gh = fakeGh(snapshot);
      gh.controls.mergeResponse = json({
        data: {
          mergePullRequest: {
            pullRequest: {
              ...snapshot.pr,
              state: "MERGED",
              merged: true,
              mergeCommit: { oid: MERGE },
              ...patch,
            },
          },
        },
      });
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expect(gh.writes).toHaveLength(1);
      expect(JSON.stringify(gh.stdout.mock.calls)).not.toContain("Merged PR");
    },
  );

  it.each([
    ["123", "--immediate", "--immediate"],
    [
      "123",
      "--immediate",
      "--force",
      "--reason",
      "https://github.com/Withso/zeros/pull/123#issuecomment-456",
    ],
    ["123", "--immediate", "--admin"],
    ["123", "--immediate", "--auto"],
    ["123", "--immediate", "--disable-auto"],
    ["123", "--immediate", "--delete-branch"],
  ])("rejects unsafe flags before gh: %j", async (...argv) => {
    const gh = fakeGh();
    expect(await runAgentMerge(argv, gh)).toBe(2);
    expect(gh.spawn).not.toHaveBeenCalled();
  });
});
