import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { runAgentMerge } from "../agent-merge.mjs";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "c".repeat(40);
const AUTHOR_EMAIL = "workspace-author@example.test";

function fixture() {
  return {
    authorIdent: `Workspace Owner <${AUTHOR_EMAIL}> 1792320000 +0000\n`,
    viewer: {
      login: "workspace-owner",
      type: "User",
      id: 42,
      node_id: "U_fixture",
    },
    graphqlViewer: {
      login: "workspace-owner",
      __typename: "User",
      databaseId: 42,
      id: "U_fixture",
    },
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
  let graphqlReads = 0;
  let restReads = 0;
  let gitReads = 0;
  let acceptedAuthorEmail = "server-default@example.test";
  const controls = {
    beforeGitRead: (_read: number, _snapshot: Snapshot) => {},
    gitResponse: null as Response | null,
    readbackPatch: {} as Record<string, unknown>,
    beforeGraphqlRead: (
      _read: number,
      _query: string,
      _snapshot: Snapshot,
    ) => {},
    beforeRestRead: (_read: number, _snapshot: Snapshot) => {},
    beforePrRead: (_read: number, _snapshot: Snapshot) => {},
    beforeOpenRead: (_read: number, _snapshot: Snapshot) => {},
    mergeResponse: null as Response | null,
    badReadback: false,
  };
  const spawn = vi.fn((command: string, args: string[], _options: unknown) => {
    calls.push(args);
    if (command === "git") {
      expect(args).toEqual(["var", "GIT_AUTHOR_IDENT"]);
      controls.beforeGitRead(++gitReads, snapshot);
      return (
        controls.gitResponse ?? {
          status: 0,
          stdout: snapshot.authorIdent,
          stderr: "",
        }
      );
    }
    if (args[0] === "api" && args[1] === "user") {
      controls.beforeRestRead(++restReads, snapshot);
      return json(snapshot.viewer);
    }
    if (args[0] === "pr" && args[1] === "checks")
      return json(
        args.includes("--required") ? snapshot.requiredChecks : snapshot.checks,
      );
    if (args[0] === "api" && args[1].includes("/files?"))
      return json([snapshot.files]);
    if (args[0] === "api" && args[1] === "graphql") {
      if (args.includes("--input")) {
        const payload = JSON.parse(
          readFileSync(args[args.indexOf("--input") + 1], "utf8"),
        );
        writes.push(payload);
        acceptedAuthorEmail =
          payload.variables.input.authorEmail ?? "server-default@example.test";
        if (controls.mergeResponse) return controls.mergeResponse;
        return json({
          data: { mergePullRequest: { pullRequest: mergedPr() } },
        });
      }
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      controls.beforeGraphqlRead(++graphqlReads, query, snapshot);
      const data = (value: Record<string, unknown>) => ({
        ...value,
        ...(query.includes("viewer {")
          ? { viewer: snapshot.graphqlViewer }
          : {}),
      });
      if (query.includes("ImmediateMergePreflight")) {
        controls.beforePrRead(++prReads, snapshot);
        return json({
          data: data({ repository: { pullRequest: snapshot.pr } }),
        });
      }
      if (query.includes("ImmediateMergeQueue"))
        return json({
          data: data({ repository: { mergeQueue: snapshot.mergeQueue } }),
        });
      if (query.includes("ImmediateMergeResult"))
        return json({
          data: data({
            repository: {
              pullRequest: controls.badReadback
                ? snapshot.pr
                : { ...mergedPr(), ...controls.readbackPatch },
            },
          }),
        });
      controls.beforeOpenRead(++openReads, snapshot);
      return json([
        {
          data: data({
            repository: {
              pullRequests: {
                nodes: snapshot.openPullRequests,
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
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
      mergeCommit: { oid: MERGE, author: { email: acceptedAuthorEmail } },
      mergedBy: snapshot.graphqlViewer,
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
  it("pins the real workspace Git author email in the API request and both receipts", async () => {
    const snapshot = fixture();
    const selected = "another-operator+merge@example.test";
    snapshot.authorIdent = `Workspace Owner <${selected}> 1792320000 +0000\n`;
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(0);
    expect(gh.writes[0].variables).toMatchObject({
      input: { authorEmail: selected },
    });
    expect(gh.calls.filter((args) => args[0] === "var")).toHaveLength(2);
    expect(gh.writes[0].query).toContain("author { email }");
  });

  it.each([
    "",
    "private-output-fixture",
    "Workspace Owner <> 1792320000 +0000\n",
    "Workspace Owner <not-an-email> 1792320000 +0000\n",
    "Workspace Owner <two words@example.test> 1792320000 +0000\n",
    "Workspace Owner <one@example.test> 1792320000 +0000\nAnother Owner <two@example.test> 1792320000 +0000\n",
    "Workspace Owner <one@example.test\u0000> 1792320000 +0000\n",
    `Workspace Owner <${"a".repeat(255)}@example.test> 1792320000 +0000\n`,
  ])(
    "refuses an unavailable or malformed effective Git author: %j",
    async (authorIdent) => {
      const snapshot = fixture();
      snapshot.authorIdent = authorIdent;
      const gh = fakeGh(snapshot);
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
      expect(
        JSON.stringify([...gh.stdout.mock.calls, ...gh.stderr.mock.calls]),
      ).not.toContain("private-output-fixture");
    },
  );

  it("refuses a failed normal Git identity read without exposing its output", async () => {
    const gh = fakeGh();
    gh.controls.gitResponse = {
      status: 1,
      stdout: "private-output-fixture",
      stderr: "private-output-fixture",
    };
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
    expect(
      JSON.stringify([...gh.stdout.mock.calls, ...gh.stderr.mock.calls]),
    ).not.toContain("private-output-fixture");
  });

  it("refuses a changed Git author email before mutation", async () => {
    const gh = fakeGh();
    gh.controls.beforeGitRead = (read, snapshot) => {
      if (read === 2)
        snapshot.authorIdent =
          "Workspace Owner <replacement@example.test> 1792320000 +0000\n";
    };
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
  });

  it("rechecks Git authorship after the final PR authority fence", async () => {
    const gh = fakeGh();
    gh.controls.beforeGraphqlRead = (read, _query, snapshot) => {
      if (read === 9)
        snapshot.authorIdent =
          "Workspace Owner <replacement@example.test> 1792320000 +0000\n";
    };
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
  });

  it.each([null, {}, { email: "other@example.test" }, { email: "" }])(
    "does not claim success when the mutation's actual commit author is unconfirmed: %j",
    async (author) => {
      const snapshot = fixture();
      const gh = fakeGh(snapshot);
      gh.controls.mergeResponse = json({
        data: {
          mergePullRequest: {
            pullRequest: {
              ...snapshot.pr,
              state: "MERGED",
              merged: true,
              mergedBy: snapshot.graphqlViewer,
              mergeCommit: { oid: MERGE, author },
            },
          },
        },
      });
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expect(gh.writes).toHaveLength(1);
      expect(JSON.stringify(gh.stdout.mock.calls)).not.toContain("Merged PR");
    },
  );

  it.each([null, {}, { email: "other@example.test" }, { email: "" }])(
    "does not claim success when readback commit authorship differs: %j",
    async (author) => {
      const gh = fakeGh();
      gh.controls.readbackPatch = { mergeCommit: { oid: MERGE, author } };
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expect(gh.writes).toHaveLength(1);
      expect(JSON.stringify(gh.stdout.mock.calls)).not.toContain("Merged PR");
    },
  );

  it("validates and pins authorship during dry-run without logging the address or writing", async () => {
    const gh = fakeGh();
    expect(await runAgentMerge(["123", "--immediate", "--dry-run"], gh)).toBe(
      0,
    );
    expect(gh.calls.filter((args) => args[0] === "var")).toHaveLength(2);
    expect(JSON.stringify(gh.stdout.mock.calls)).not.toContain(AUTHOR_EMAIL);
    expectNoWrite(gh);
  });
  it("refuses a bot GraphQL viewer even when its typename is User and REST qualifies a human", async () => {
    const snapshot = fixture();
    snapshot.graphqlViewer = {
      login: "automation[bot]",
      __typename: "User",
      id: "BOT_fixture",
      databaseId: 43,
    };
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
    expect(gh.stderr).toHaveBeenCalledWith(
      expect.stringContaining("same human workspace identity"),
    );
  });

  it.each(["login", "id", "databaseId", "__typename"])(
    "refuses absent GraphQL principal %s",
    async (field) => {
      const snapshot = fixture();
      Reflect.deleteProperty(snapshot.graphqlViewer, field);
      const gh = fakeGh(snapshot);
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it.each([
    { login: "other-human" },
    { id: "U_other" },
    { databaseId: 43 },
    { __typename: "Bot" },
  ])(
    "binds the effective GraphQL principal, not just its type: %j",
    async (patch) => {
      const snapshot = fixture();
      Object.assign(snapshot.graphqlViewer, patch);
      const gh = fakeGh(snapshot);
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it.each(["id", "node_id"])(
    "requires the REST principal's immutable %s",
    async (field) => {
      const snapshot = fixture();
      Reflect.deleteProperty(snapshot.viewer, field);
      const gh = fakeGh(snapshot);
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
    "fences a GraphQL principal change at read %s before writing",
    async (changeAt) => {
      const gh = fakeGh();
      gh.controls.beforeGraphqlRead = (read, _query, snapshot) => {
        if (read === changeAt) snapshot.graphqlViewer.id = "U_other";
      };
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it.each([2, 3])(
    "refuses an identity switch even when REST and GraphQL agree on a new human at REST read %s",
    async (changeAt) => {
      const gh = fakeGh();
      gh.controls.beforeRestRead = (read, snapshot) => {
        if (read === changeAt) {
          snapshot.viewer = {
            login: "other-human",
            type: "User",
            id: 43,
            node_id: "U_other",
          };
          snapshot.graphqlViewer = {
            login: "other-human",
            __typename: "User",
            databaseId: 43,
            id: "U_other",
          };
        }
      };
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it("does not report success after the effective GraphQL readback identity changes", async () => {
    const gh = fakeGh();
    gh.controls.beforeGraphqlRead = (read, _query, snapshot) => {
      if (read === 10) snapshot.graphqlViewer.id = "U_other";
    };
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expect(gh.writes).toHaveLength(1);
    expect(JSON.stringify(gh.stdout.mock.calls)).not.toContain("Merged PR");
  });

  it.each([2, 3])(
    "pins immutable human IDs even when the login stays equal at REST read %s",
    async (changeAt) => {
      const gh = fakeGh();
      gh.controls.beforeRestRead = (read, snapshot) => {
        if (read === changeAt) {
          snapshot.viewer.id = snapshot.graphqlViewer.databaseId = 43;
          snapshot.viewer.node_id = snapshot.graphqlViewer.id = "U_replacement";
        }
      };
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it.each(["missing", "mismatched"])(
    "validates a %s GraphQL principal on a later open-PR page",
    async (state) => {
      const snapshot = fixture();
      const gh = fakeGh(snapshot);
      const original = gh.spawn.getMockImplementation()!;
      gh.spawn.mockImplementation((command, args, options) => {
        const result = original(command, args, options);
        if (
          args[0] !== "api" ||
          args[1] !== "graphql" ||
          !args.includes("--paginate")
        )
          return result;
        const pages = JSON.parse(result.stdout);
        const second = structuredClone(pages[0]);
        pages[0].data.repository.pullRequests.pageInfo = {
          hasNextPage: true,
          endCursor: "next",
        };
        second.data.repository.pullRequests.nodes = [];
        if (state === "missing") delete second.data.viewer;
        else second.data.viewer = { ...snapshot.graphqlViewer, id: "U_other" };
        return json([...pages, second]);
      });
      expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
      expectNoWrite(gh);
    },
  );

  it("selects the effective principal with each immediate GraphQL read and the actual merger in its receipt", async () => {
    const gh = fakeGh();
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(0);
    const queries = gh.calls.filter(
      (args) =>
        args[0] === "api" && args[1] === "graphql" && !args.includes("--input"),
    );
    expect(queries).toHaveLength(10);
    for (const query of queries)
      expect(query.find((arg) => arg.startsWith("query="))).toContain(
        "viewer {",
      );
    expect(gh.writes[0].query).toContain("mergedBy {");
    expect(gh.writes[0].query).toContain("... on User { id databaseId }");
  });

  it("refuses an absent effective GraphQL viewer before writing", async () => {
    const snapshot = fixture();
    Reflect.deleteProperty(snapshot, "graphqlViewer");
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
  });

  it.each([
    null,
    {
      login: "automation[bot]",
      __typename: "User",
      id: "BOT_fixture",
      databaseId: 43,
    },
    {
      login: "workspace-owner",
      __typename: "User",
      id: "U_other",
      databaseId: 42,
    },
    {
      login: "workspace-owner",
      __typename: "User",
      id: "U_fixture",
      databaseId: 43,
    },
  ])(
    "does not report a merge by an unqualified effective principal: %j",
    async (mergedBy) => {
      const snapshot = fixture();
      const gh = fakeGh(snapshot);
      gh.controls.mergeResponse = json({
        data: {
          mergePullRequest: {
            pullRequest: {
              ...snapshot.pr,
              state: "MERGED",
              merged: true,
              mergeCommit: { oid: MERGE, author: { email: AUTHOR_EMAIL } },
              mergedBy,
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
    ["pass", "NEUTRAL"],
    ["skipping", "UNKNOWN"],
    ["skipping", "FAILURE"],
    ["skipping", ""],
    ["pass", "SKIPPED"],
  ])("refuses malformed optional check pairs %s/%s", async (bucket, state) => {
    const snapshot = fixture();
    snapshot.checks[1] = { name: "optional", bucket, state };
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(1);
    expectNoWrite(gh);
  });
  it.each([
    "docs/navigation.md",
    "apps/control-plane/src/cloud/routes.ts",
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
          authorEmail: AUTHOR_EMAIL,
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
        if (call[0] === "git")
          expect(call[1]).toEqual(["var", "GIT_AUTHOR_IDENT"]);
        else expect(call[0]).toBe("gh");
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
    ["skipping", "NEUTRAL"],
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
    snapshot.checks[1] = {
      name: "optional",
      bucket: "skipping",
      state: "NEUTRAL",
    };
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--immediate"], gh)).toBe(0);
    expect(gh.writes).toHaveLength(1);
    snapshot.requiredChecks[0] = {
      name: "test",
      bucket: "skipping",
      state: "NEUTRAL",
    };
    snapshot.checks[0] = { ...snapshot.requiredChecks[0] };
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
    { mergeCommit: { oid: "invalid", author: { email: AUTHOR_EMAIL } } },
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
              mergeCommit: { oid: MERGE, author: { email: AUTHOR_EMAIL } },
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
    ["123", "--immediate", "--author-email", "override@example.test"],
  ])("rejects unsafe flags before gh: %j", async (...argv) => {
    const gh = fakeGh();
    expect(await runAgentMerge(argv, gh)).toBe(2);
    expect(gh.spawn).not.toHaveBeenCalled();
  });
});
