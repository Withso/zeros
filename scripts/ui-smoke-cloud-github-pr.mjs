import { expect } from "@playwright/test";
import { join } from "node:path";

export async function runCloudGithubPrSmoke({
  page,
  harnessBase,
  check,
  screenshotDirectory,
}) {
  const organizationId = "22222222-2222-4222-8222-222222222222";
  const ids = [
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  const headSha = "a".repeat(40),
    baseSha = "b".repeat(40);
  const requests = [],
    unexpected = [];
  const rows = ids.map((id, index) => ({
    id,
    organizationId,
    creatorUserId: "11111111-1111-4111-8111-111111111111",
    name: `Workspace ${index}`,
    repository: `example/${index ? "second" : "project"}`,
    branch: "feature",
    baseBranch: "main",
    state: index ? "stopped" : "running",
    errorCode: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    version: 2,
    capabilities: {
      design: false,
      browser: false,
      simulators: false,
      terminal: true,
      files: true,
      git: true,
      agents: ["codex"],
      githubPullRequests: 1,
    },
    github: {
      repositoryId: String(42 + index),
      branch: "feature",
      baseBranch: "main",
      headSha,
      prNumber: index ? 9 : null,
      prState: index ? "ready" : null,
      prUrl: index ? "https://github.com/example/second/pull/9" : null,
    },
  }));
  const replies = [[], []],
    resolved = [false, false];
  const pr = (index) => ({
    number: rows[index].github.prNumber,
    state: rows[index].github.prState,
    url: rows[index].github.prUrl,
    title: `Cloud change ${index}`,
    body: "Description",
    authorLogin: "contributor",
    headBranch: "feature",
    baseBranch: "main",
    headSha,
    baseSha,
    headRepository: rows[index].repository,
    mergeableState: "clean",
    isMergeable: true,
    createdAt: 1,
    updatedAt: 2,
    mergedAt: null,
    mergeCommitSha: null,
  });
  const comment = (body, id = "COMMENT_fixture") => ({
    id,
    databaseId: 71,
    author: { login: "reviewer", avatarUrl: null, kind: "human" },
    body,
    url: "https://github.com/example/project/pull/7#discussion_r71",
    createdAt: 1,
    updatedAt: 1,
    commitSha: headSha,
  });
  let held = null,
    holdNext = false;
  const route = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/me")
      return route.fulfill({
        json: {
          user: {
            id: rows[0].creatorUserId,
            email: "fixture@example.test",
            displayName: "Cloud fixture",
            staffRole: null,
          },
          organizations: [
            {
              id: organizationId,
              slug: "fixture",
              name: "Fixture",
              logo: null,
              role: "member",
              isPersonal: false,
              defaultTeamId: null,
              workspaceCapabilities: { local: true, cloud: true },
              teamCapabilities: { multiple: false, canCreate: false },
            },
          ],
        },
      });
    const index = ids.findIndex((id) => url.pathname.includes(id));
    if (index < 0) {
      unexpected.push(url.pathname);
      return route.fulfill({
        status: 404,
        json: { error: { code: "fixture", message: "Unexpected API request" } },
      });
    }
    if (
      route.request().method() === "GET" &&
      url.pathname === `/v1/cloud-v2/workspaces/${ids[index]}`
    )
      return route.fulfill({ json: { workspace: rows[index] } });
    if (!url.pathname.endsWith("/github")) {
      unexpected.push(url.pathname);
      return route.abort();
    }
    const body = route.request().postDataJSON();
    requests.push({ index, ...body });
    const authority = {
      connectionGeneration: "cloud-generation",
      repositoryId: rows[index].github.repositoryId,
      repository: rows[index].repository,
      branch: "feature",
      baseBranch: "main",
      contextRevision: "boot:1",
    };
    let result;
    if (body.op === "gh.repoAccess") result = { state: "ok", connected: true };
    else if (body.op === "gh.prCreate") {
      rows[index].github = {
        ...rows[index].github,
        prNumber: 7,
        prState: body.params.draft ? "draft" : "ready",
        prUrl: `https://github.com/${rows[index].repository}/pull/7`,
      };
      rows[index].updatedAt = "2026-01-03T00:00:00Z";
      result = pr(index);
    } else if (body.op === "gh.prMarkReady") {
      rows[index].github.prState = "ready";
      rows[index].updatedAt = "2026-01-04T00:00:00Z";
      result = pr(index);
    } else if (["gh.prGet", "gh.prSync"].includes(body.op))
      result = rows[index].github.prNumber ? pr(index) : null;
    else if (body.op === "gh.prChecks")
      result = {
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        checks: [
          {
            name: "Unit tests",
            status: "completed",
            conclusion: "success",
            detailsUrl: null,
            startedAt: 1,
            completedAt: 2,
          },
        ],
        deployments: [],
      };
    else if (body.op === "gh.prInlineReview")
      result = {
        headSha,
        baseSha,
        threadsTruncated: false,
        annotations: [],
        annotationsTruncated: false,
        annotationError: null,
        threads: [
          {
            id: `THREAD_${index}`,
            path: "src/example.ts",
            side: "RIGHT",
            startLine: null,
            line: 2,
            originalStartLine: null,
            originalLine: 2,
            isResolved: resolved[index],
            isOutdated: false,
            canResolve: true,
            canUnresolve: true,
            commentsTruncated: false,
            comments: [
              comment(`Review for workspace ${index === 0 ? "A" : "B"}`),
              ...replies[index],
            ],
          },
        ],
      };
    else if (body.op === "gh.prComment" && body.params.kind === "reply") {
      replies[index].push(comment(body.params.body, "COMMENT_reply"));
      result = { id: 72, url: `${rows[index].github.prUrl}#discussion_r72` };
    } else if (body.op === "gh.prComment" && body.params.kind === "resolve") {
      resolved[index] = body.params.resolved;
      result = { resolved: body.params.resolved };
    } else {
      unexpected.push(body.op);
      return route.abort();
    }
    if (holdNext && body.op === "gh.prInlineReview") {
      holdNext = false;
      await new Promise((resolve) => {
        held = resolve;
      });
    }
    return route.fulfill({ json: { authority, result } });
  };
  await page.route("https://api.example.test/**", route);
  try {
    await page.goto(`${harnessBase}/harness-cloud-github-pr.html`);
    const create = page.getByRole("button", { name: "Create PR", exact: true });
    await expect(create).toBeEnabled();
    await expect
      .poll(() => requests.filter((r) => r.op === "gh.prSync").length)
      .toBe(1);
    await page.getByRole("button", { name: "More PR options" }).click();
    await page
      .getByRole("menuitem", { name: "Create draft directly", exact: true })
      .click();
    await expect(create).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Ready for review", exact: true }),
    ).toBeVisible();
    expect(requests.filter((r) => r.op === "gh.prCreate")).toHaveLength(1);
    expect(
      await page.evaluate(() =>
        window.cloudPrFixture.workerCalls.filter(
          (call) => call.op === "workspace.prepareGithub",
        ),
      ),
    ).toHaveLength(1);
    check(
      "Cloud direct creation publishes through its worker and adopts the returned PR",
      true,
    );

    await page
      .getByRole("button", { name: "Ready for review", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Merge", exact: true }),
    ).toBeEnabled();
    expect(requests.find((r) => r.op === "gh.prMarkReady")).toMatchObject({
      expected: { repositoryId: "42", branch: "feature" },
      params: { headSha, baseSha },
    });
    check(
      "Cloud readiness uses the displayed revision and current checks",
      true,
    );

    await expect(
      page.getByText("Review for workspace A", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await page
      .getByRole("textbox")
      .fill("Cloud reply from the selected connection");
    await page
      .getByRole("button", { name: "Post reply to PR", exact: true })
      .click();
    await expect(
      page.getByText("Cloud reply from the selected connection", {
        exact: true,
      }),
    ).toBeVisible();
    if (screenshotDirectory)
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (theme) => document.documentElement.setAttribute("data-theme", theme),
          theme,
        );
        await page
          .getByRole("region", { name: "Cloud PR workspace" })
          .screenshot({
            path: join(screenshotDirectory, `cloud-github-pr-${theme}.png`),
            animations: "disabled",
          });
      }
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Expand resolved discussion" }),
    ).toBeVisible();
    expect(
      requests.filter((r) => r.op === "gh.prComment").map((r) => r.params.kind),
    ).toEqual(["reply", "resolve"]);
    check(
      "Cloud review replies and resolution use HTTPS with explicit PR revisions",
      true,
    );

    const publish = async (value) =>
      page.evaluate((value) => window.cloudPrFixture.publish(value), value);
    rows[0].state = "stopped";
    rows[0].updatedAt = "2026-01-05T00:00:00Z";
    await publish(rows[0]);
    await page
      .getByRole("button", { name: "Workspace B", exact: true })
      .click();
    await expect(
      page.getByText("Review for workspace B", { exact: true }),
    ).toBeVisible();
    const workerCount = await page.evaluate(
      () => window.cloudPrFixture.workerCalls.length,
    );
    await page
      .getByRole("button", { name: "Refresh published review" })
      .click();
    await expect
      .poll(
        () =>
          requests.filter((r) => r.index === 1 && r.op === "gh.prInlineReview")
            .length,
      )
      .toBe(2);
    expect(
      await page.evaluate(() => window.cloudPrFixture.workerCalls.length),
    ).toBe(workerCount);
    check(
      "Published cloud review and checks stay readable while the VM is stopped",
      true,
    );

    holdNext = true;
    await page
      .getByRole("button", { name: "Refresh published review" })
      .click();
    await expect.poll(() => held !== null).toBe(true);
    await page
      .getByRole("button", { name: "Workspace A", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Expand resolved discussion" }),
    ).toBeVisible();
    held();
    held = null;
    await expect(
      page.getByText("Review for workspace B", { exact: true }),
    ).toHaveCount(0);
    check(
      "A held review response cannot replace the restored workspace's discussion",
      true,
    );

    await page.clock.install();
    await page.getByRole("button", { name: "Hide PR", exact: true }).click();
    const count = requests.length;
    await page.clock.runFor(70_000);
    expect(requests).toHaveLength(count);
    check(
      "Hidden cloud PR surfaces stop discovery, checks and review polling",
      true,
    );
    delete rows[0].capabilities.githubPullRequests;
    delete rows[0].github;
    rows[0].githubUnavailableReason = "connection-required";
    await publish(rows[0]);
    await page.getByRole("button", { name: "Show PR", exact: true }).click();
    await expect(
      page.getByText(
        "Connect GitHub in Settings → Integrations to use pull requests.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Review for workspace A", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Expand resolved discussion" }),
    ).toHaveCount(0);
    check(
      "Connection loss replaces protected PR and discussion data with recovery guidance",
      true,
    );
    expect(unexpected).toEqual([]);
    expect(
      await page.evaluate(() =>
        window.cloudPrFixture.nativeCalls.filter((command) =>
          command.startsWith("gh_"),
        ),
      ),
    ).toEqual([]);
  } finally {
    held?.();
    await page.unroute("https://api.example.test/**", route);
  }
}
