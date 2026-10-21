import { readFileSync, existsSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { decideMerge, runAgentMerge } from "../agent-merge.mjs";

const HEAD = "a".repeat(40);
const REPOSITORY = "Withso/zeros";
const COMMENT_URL = `https://github.com/${REPOSITORY}/pull/123#issuecomment-456`;
const OWNER_REVIEW =
  "This PR changes CI definitions; the owner must review and merge it.";

type AutoMerge = { enabledAt: string } | null;
type Snapshot = {
  viewer: { login: string; type: string };
  pr: {
    number: number;
    title: string;
    body: string;
    state: string;
    isDraft: boolean;
    isCrossRepository: boolean;
    headRefOid: string;
    changedFiles: number;
    autoMergeRequest: AutoMerge;
  };
  files: { filename: string; status: string; previous_filename?: string }[];
  requiredChecks: { name: string; bucket: string; state: string }[];
  openPullRequests: { number: number; autoMergeRequest: AutoMerge }[];
  forceComment: {
    html_url: string;
    issue_url: string;
    body: string;
    user: { login: string; type: string };
  };
};

function fixture(): Snapshot {
  return {
    viewer: { login: "workspace-owner", type: "User" },
    pr: {
      number: 123,
      title: "Fix workspace navigation",
      body: "Keep the selected workspace while refreshing.",
      state: "OPEN",
      isDraft: false,
      isCrossRepository: false,
      headRefOid: HEAD,
      changedFiles: 1,
      autoMergeRequest: null,
    },
    files: [
      {
        filename: "apps/desktop/src/renderer/state/navigation.ts",
        status: "modified",
      },
    ],
    requiredChecks: [{ name: "test", bucket: "pass", state: "SUCCESS" }],
    openPullRequests: [{ number: 123, autoMergeRequest: null }],
    forceComment: {
      html_url: COMMENT_URL,
      issue_url: `https://api.github.com/repos/${REPOSITORY}/issues/123`,
      body: "I approve the additional armed merge while the existing PR waits for checks.",
      user: { login: "workspace-owner", type: "User" },
    },
  };
}

// The shared policy is supplied independently; the wrapper must consult it,
// including paths outside .github/workflows and the policy module itself.
const isCiDefinitionPath = (file: string) =>
  file.startsWith("scripts/ci/") ||
  file === "vitest.config.ts" ||
  file === "pnpm-lock.yaml";

function fakeGh(snapshot = fixture()) {
  const calls: string[][] = [];
  const responses = new Map<
    string,
    { status: number; stdout: string; stderr?: string }
  >();
  const spawn = vi.fn((_command: string, args: string[], _options: unknown) => {
    calls.push(args);
    const key = args.slice(0, 3).join(" ");
    const override = responses.get(key);
    if (override) return override;
    if (args[0] === "pr" && args[1] === "view") return json(snapshot.pr);
    if (args[0] === "pr" && args[1] === "checks")
      return json(snapshot.requiredChecks);
    if (args[0] === "api" && args[1] === "user") return json(snapshot.viewer);
    if (args[0] === "api" && args[1].includes("/files?"))
      return json([snapshot.files]);
    if (args[0] === "api" && args[1] === "graphql") {
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
    if (args[0] === "api" && args[1].includes("/issues/comments/"))
      return json(snapshot.forceComment);
    if (args[0] === "pr" && args[1] === "merge") {
      const bodyFile = args[args.indexOf("--body-file") + 1];
      expect(readFileSync(bodyFile, "utf8")).toBe(snapshot.pr.body);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error("Unexpected gh invocation");
  });
  const stdout = vi.fn();
  const stderr = vi.fn();
  const loadCiDefinition = vi.fn(
    async (): Promise<typeof isCiDefinitionPath | null> => isCiDefinitionPath,
  );
  return { calls, responses, spawn, stdout, stderr, loadCiDefinition };
}

function json(value: unknown, status = 0) {
  return { status, stdout: JSON.stringify(value), stderr: "" };
}

describe("agent merge decision", () => {
  it("exports a pure decision that keeps its input unchanged", () => {
    const snapshot = fixture();
    const before = structuredClone(snapshot);
    expect(decideMerge(snapshot, { isCiDefinitionPath })).toMatchObject({
      allowed: true,
      code: "arm",
    });
    expect(snapshot).toEqual(before);
  });

  it.each([
    "scripts/ci/ci-definition.mjs",
    "scripts/ci/select-checks.mjs",
    ".github/workflows/preflight.yml",
    ".github/workflows/codeql.yml",
    "vitest.config.ts",
    "pnpm-lock.yaml",
  ])("requires owner review for %s", async (filename) => {
    const snapshot = fixture();
    snapshot.files = [{ filename, status: "modified" }];
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123", "--dry-run"], gh)).toBe(1);
    expect(gh.stderr).toHaveBeenCalledWith(OWNER_REVIEW);
    expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
  });

  it("checks the previous path of a renamed CI definition", () => {
    const snapshot = fixture();
    snapshot.files = [
      {
        filename: "docs/former-config.md",
        status: "renamed",
        previous_filename: "vitest.config.ts",
      },
    ];
    expect(decideMerge(snapshot, { isCiDefinitionPath })).toMatchObject({
      allowed: false,
      code: "ci-definition",
    });
  });

  it.each([
    "[skip ci]",
    "[ci skip]",
    "[no ci]",
    "[skip actions]",
    "[actions skip]",
    "skip-checks: true",
    "SKIP-CHECKS:true",
  ])(
    "refuses %s in either the PR title or body, case-insensitively",
    async (marker) => {
      for (const field of ["title", "body"] as const) {
        const snapshot = fixture();
        snapshot.pr[field] += ` ${marker.toUpperCase()}`;
        const gh = fakeGh(snapshot);
        expect(await runAgentMerge(["123"], gh)).toBe(1);
        expect(gh.stderr).toHaveBeenCalledWith(
          expect.stringContaining("skip marker"),
        );
        expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
      }
    },
  );

  it.each([
    [
      "a draft PR",
      (s: Snapshot) => {
        s.pr.isDraft = true;
      },
      "draft",
    ],
    [
      "a fork PR",
      (s: Snapshot) => {
        s.pr.isCrossRepository = true;
      },
      "fork",
    ],
    [
      "a closed PR",
      (s: Snapshot) => {
        s.pr.state = "CLOSED";
      },
      "closed",
    ],
    [
      "a missing head SHA",
      (s: Snapshot) => {
        s.pr.headRefOid = "";
      },
      "metadata",
    ],
    [
      "incomplete file pagination",
      (s: Snapshot) => {
        s.pr.changedFiles = 2;
      },
      "files",
    ],
    [
      "a bot identity",
      (s: Snapshot) => {
        s.viewer.type = "Bot";
      },
      "identity",
    ],
    [
      "a failed required check",
      (s: Snapshot) => {
        s.requiredChecks[0].bucket = "fail";
      },
      "checks",
    ],
    [
      "a cancelled required check",
      (s: Snapshot) => {
        s.requiredChecks[0].bucket = "cancel";
      },
      "checks",
    ],
    [
      "an unknown check result",
      (s: Snapshot) => {
        s.requiredChecks[0].bucket = "unknown";
      },
      "checks-unavailable",
    ],
  ])("refuses %s without invoking merge", async (_label, change, code) => {
    const snapshot = fixture();
    change(snapshot);
    expect(decideMerge(snapshot, { isCiDefinitionPath })).toMatchObject({
      allowed: false,
      code,
    });
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123"], gh)).toBe(1);
    expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
  });

  it.each(["added", "modified", "removed"])(
    "requires owner resolution for %s incident markers",
    async (status) => {
      const snapshot = fixture();
      snapshot.files = [
        { filename: ".github/ci-incidents/incident-123.json", status },
      ];
      const gh = fakeGh(snapshot);
      expect(await runAgentMerge(["123"], gh)).toBe(1);
      expect(gh.stderr).toHaveBeenCalledWith(
        expect.stringContaining("incident marker"),
      );
      expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
    },
  );

  it("also refuses renamed incident markers", () => {
    const snapshot = fixture();
    snapshot.files = [
      {
        filename: "docs/incident.json",
        status: "renamed",
        previous_filename: ".github/ci-incidents/incident-123.json",
      },
    ];
    expect(decideMerge(snapshot, { isCiDefinitionPath })).toMatchObject({
      allowed: false,
      code: "incident",
    });
  });

  it("refuses another armed PR but ignores auto-merge on the target PR", async () => {
    const snapshot = fixture();
    snapshot.openPullRequests = [
      { number: 123, autoMergeRequest: { enabledAt: "2026-10-06T00:00:00Z" } },
      { number: 124, autoMergeRequest: { enabledAt: "2026-10-06T00:00:00Z" } },
    ];
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123"], gh)).toBe(1);
    expect(gh.stderr).toHaveBeenCalledWith(expect.stringContaining("#124"));
    snapshot.openPullRequests.pop();
    expect(decideMerge(snapshot, { isCiDefinitionPath })).toMatchObject({
      allowed: true,
    });
  });

  it("permits pending required checks because GitHub waits for them", async () => {
    const snapshot = fixture();
    snapshot.requiredChecks[0] = {
      name: "test",
      bucket: "pending",
      state: "IN_PROGRESS",
    };
    const gh = fakeGh(snapshot);
    gh.responses.set("pr checks 123", json(snapshot.requiredChecks, 8));
    expect(await runAgentMerge(["123", "--dry-run"], gh)).toBe(0);
    expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
  });

  it("fails closed when the shared CI-definition policy is unavailable", async () => {
    const gh = fakeGh();
    gh.loadCiDefinition.mockResolvedValue(null);
    expect(await runAgentMerge(["123", "--dry-run"], gh)).toBe(1);
    expect(gh.stderr).toHaveBeenCalledWith(
      expect.stringContaining("CI-definition policy is unavailable"),
    );
    expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
  });
});

describe("documented human override", () => {
  it("allows only the one-armed-PR override with the caller's human PR comment", async () => {
    const snapshot = fixture();
    snapshot.openPullRequests.push({
      number: 124,
      autoMergeRequest: { enabledAt: "2026-10-06T00:00:00Z" },
    });
    const gh = fakeGh(snapshot);
    expect(
      await runAgentMerge(["123", "--force", "--reason", COMMENT_URL], gh),
    ).toBe(0);
    expect(gh.calls).toContainEqual([
      "api",
      `repos/${REPOSITORY}/issues/comments/456`,
    ]);
    expect(gh.calls.some((args) => args[1] === "merge")).toBe(true);
    expect(gh.stdout).toHaveBeenCalledWith(
      expect.stringContaining(COMMENT_URL),
    );
  });

  it.each([
    [
      "a bot comment",
      (s: Snapshot) => {
        s.forceComment.user.type = "Bot";
      },
    ],
    [
      "another user's comment",
      (s: Snapshot) => {
        s.forceComment.user.login = "another-user";
      },
    ],
    [
      "a comment on another PR",
      (s: Snapshot) => {
        s.forceComment.issue_url = `https://api.github.com/repos/${REPOSITORY}/issues/124`;
      },
    ],
    [
      "a blank justification",
      (s: Snapshot) => {
        s.forceComment.body = " ";
      },
    ],
  ])("refuses %s", async (_label, change) => {
    const snapshot = fixture();
    change(snapshot);
    const gh = fakeGh(snapshot);
    expect(
      await runAgentMerge(["123", "--force", "--reason", COMMENT_URL], gh),
    ).toBe(1);
    expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
  });

  it.each(["ci", "skip", "draft", "fork", "incident", "checks"])(
    "cannot override the %s guard",
    async (guard) => {
      const snapshot = fixture();
      if (guard === "ci") snapshot.files[0].filename = "vitest.config.ts";
      if (guard === "skip") snapshot.pr.body = "[skip ci]";
      if (guard === "draft") snapshot.pr.isDraft = true;
      if (guard === "fork") snapshot.pr.isCrossRepository = true;
      if (guard === "incident")
        snapshot.files[0].filename = ".github/ci-incidents/open.json";
      if (guard === "checks") snapshot.requiredChecks[0].bucket = "fail";
      const gh = fakeGh(snapshot);
      expect(
        await runAgentMerge(["123", "--force", "--reason", COMMENT_URL], gh),
      ).toBe(1);
      expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
    },
  );
});

describe("agent merge CLI", () => {
  it("uses the workspace gh, pins the checked head and supplies the checked commit message", async () => {
    const snapshot = fixture();
    snapshot.pr.title = "Fix navigation `literal` $(literal)";
    const gh = fakeGh(snapshot);
    expect(await runAgentMerge(["123"], gh)).toBe(0);
    const merge = gh.calls.find((args) => args[1] === "merge")!;
    expect(merge.slice(0, 9)).toEqual([
      "pr",
      "merge",
      "123",
      "--repo",
      REPOSITORY,
      "--auto",
      "--squash",
      "--match-head-commit",
      HEAD,
    ]);
    expect(merge.slice(9, 11)).toEqual([
      "--subject",
      `${snapshot.pr.title} (#123)`,
    ]);
    expect(existsSync(merge[merge.indexOf("--body-file") + 1])).toBe(false);
    for (const call of gh.spawn.mock.calls) {
      expect(call[0]).toBe("gh");
      expect(call[2]).toMatchObject({ shell: false, stdio: "pipe" });
      expect(call[2]).not.toHaveProperty("env.GH_TOKEN");
    }
    expect(gh.calls).toContainEqual([
      "pr",
      "checks",
      "123",
      "--repo",
      REPOSITORY,
      "--required",
      "--json",
      "name,bucket,state",
    ]);
  });

  it("prints the permitted command during dry-run without mutating", async () => {
    const gh = fakeGh();
    expect(await runAgentMerge(["--dry-run", "123"], gh)).toBe(0);
    expect(gh.stdout).toHaveBeenCalledWith(
      expect.stringContaining(`--match-head-commit ${HEAD}`),
    );
    expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
    expect(gh.stderr).not.toHaveBeenCalled();
  });

  it("reads every file page and detects protected renamed paths on a later page", async () => {
    const snapshot = fixture();
    snapshot.pr.changedFiles = 2;
    const gh = fakeGh(snapshot);
    gh.responses.set(
      `api repos/${REPOSITORY}/pulls/123/files?per_page=100 --paginate`,
      json([
        snapshot.files,
        [
          {
            filename: "docs/config.md",
            previous_filename: "vitest.config.ts",
            status: "renamed",
          },
        ],
      ]),
    );
    expect(await runAgentMerge(["123"], gh)).toBe(1);
    expect(gh.stderr).toHaveBeenCalledWith(OWNER_REVIEW);
    expect(gh.calls).toContainEqual([
      "api",
      `repos/${REPOSITORY}/pulls/123/files?per_page=100`,
      "--paginate",
      "--slurp",
    ]);
  });

  it("reads every open-PR page instead of only the first 100 PRs", async () => {
    const gh = fakeGh();
    const page = (nodes: unknown[], hasNextPage = false) => ({
      data: {
        repository: {
          pullRequests: {
            nodes,
            pageInfo: {
              hasNextPage,
              endCursor: hasNextPage ? "next-page" : null,
            },
          },
        },
      },
    });
    gh.responses.set(
      "api graphql --paginate",
      json([
        page([{ number: 123, autoMergeRequest: null }], true),
        page([
          {
            number: 999,
            autoMergeRequest: { enabledAt: "2026-10-06T00:00:00Z" },
          },
        ]),
      ]),
    );
    expect(await runAgentMerge(["123"], gh)).toBe(1);
    expect(gh.stderr).toHaveBeenCalledWith(expect.stringContaining("#999"));
    expect(gh.calls.find((args) => args[1] === "graphql")).toContain("--slurp");
  });

  it.each([
    [
      "pr view 123",
      { status: 1, stdout: "", stderr: "private-output-fixture" },
    ],
    [
      "pr view 123",
      { status: 0, stdout: "invalid JSON private-output-fixture" },
    ],
    ["pr checks 123", json(null)],
    [
      "api graphql --paginate",
      json([{ errors: [{ message: "private-output-fixture" }] }]),
    ],
    [
      "api graphql --paginate",
      json([
        {
          data: {
            repository: { pullRequests: { nodes: fixture().openPullRequests } },
          },
        },
      ]),
    ],
    [
      `api repos/${REPOSITORY}/pulls/123/files?per_page=100 --paginate`,
      json([{}]),
    ],
  ])(
    "fails closed on unavailable or malformed gh data (%s) without echoing it",
    async (key, response) => {
      const gh = fakeGh();
      gh.responses.set(key, response);
      expect(await runAgentMerge(["123"], gh)).toBe(1);
      expect(gh.calls.some((args) => args[1] === "merge")).toBe(false);
      expect(JSON.stringify(gh.stderr.mock.calls)).not.toContain(
        "private-output-fixture",
      );
    },
  );

  it("reports a merge failure without echoing gh output and cleans up the body file", async () => {
    const gh = fakeGh();
    gh.responses.set("pr merge 123", {
      status: 1,
      stdout: "private-output-fixture",
      stderr: "private-output-fixture",
    });
    expect(await runAgentMerge(["123"], gh)).toBe(1);
    const merge = gh.calls.find((args) => args[1] === "merge")!;
    expect(existsSync(merge[merge.indexOf("--body-file") + 1])).toBe(false);
    expect(JSON.stringify(gh.stderr.mock.calls)).not.toContain(
      "private-output-fixture",
    );
  });

  it.each([
    [],
    ["--admin", "123"],
    ["123", "--merge"],
    ["123", "124"],
    ["--repo", "elsewhere/repo", "123"],
    ["123", "--force"],
    ["123", "--reason", COMMENT_URL],
    ["123", "--force", "--reason", "not-a-comment"],
    ["124", "--force", "--reason", COMMENT_URL],
    ["https://github.com/another/repo/pull/123"],
  ])("rejects invalid arguments before running gh: %j", async (...argv) => {
    const gh = fakeGh();
    expect(await runAgentMerge(argv, gh)).toBe(2);
    expect(gh.spawn).not.toHaveBeenCalled();
  });
});
