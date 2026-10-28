import { z } from "zod";
import { HttpError } from "../authz.js";
import {
  CloudGithubHttp,
  githubDate,
  githubId,
  githubName,
  githubSha,
  resolveCloudGithubRepository,
  type CloudGithubHttpOptions,
  type CloudGithubRepositoryIdentity,
  type CloudGithubRepositoryTarget,
} from "./github-http.js";

export type CloudGithubPrTarget = CloudGithubRepositoryTarget & {
  branch: string;
  baseBranch: string;
};
const repository = z.object({
  id: githubId,
  name: githubName,
  owner: z.object({ login: githubName }),
});
const ref = z.object({
  ref: z.string().min(1).max(255),
  sha: githubSha,
  repo: repository.nullable(),
});
const pullSchema = z.object({
  number: githubId,
  node_id: z.string().min(1).max(256),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().nullable().optional(),
  title: z.string().max(1024),
  body: z.string().max(100_000).nullable(),
  user: z.object({ login: githubName }).nullable(),
  base: ref,
  head: ref,
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().max(64).optional(),
  created_at: githubDate,
  updated_at: githubDate,
  merged_at: githubDate.nullable().optional(),
  merge_commit_sha: githubSha.nullable().optional(),
});
type Pull = z.infer<typeof pullSchema>;
const prChanged = () =>
  new HttpError(
    409,
    "github_pr_changed",
    "The pull request changed. Refresh before trying again.",
  );
const identityChanged = () =>
  new HttpError(
    409,
    "github_pr_identity_changed",
    "This pull request does not match the workspace repository and branch.",
  );
// Keep the final operation bound to the verified ID even if a transfer reuses
// its previous owner/name between repository resolution and the request.
const repoPath = (repository: CloudGithubRepositoryIdentity) =>
  `/repositories/${repository.repositoryId}`;

function projection(p: Pull) {
  return {
    number: p.number,
    url: p.html_url,
    state: p.merged_at
      ? ("merged" as const)
      : p.state === "closed"
        ? ("closed" as const)
        : p.draft
          ? ("draft" as const)
          : ("ready" as const),
    title: p.title,
    body: p.body ?? "",
    authorLogin: p.user?.login ?? "",
    baseBranch: p.base.ref,
    headBranch: p.head.ref,
    headSha: p.head.sha,
    baseSha: p.base.sha,
    headRepository: p.head.repo
      ? `${p.head.repo.owner.login}/${p.head.repo.name}`
      : null,
    mergeableState: p.mergeable_state ?? "unknown",
    isMergeable: p.mergeable ?? null,
    createdAt: Date.parse(p.created_at),
    updatedAt: Date.parse(p.updated_at),
    mergedAt: p.merged_at ? Date.parse(p.merged_at) : null,
    mergeCommitSha: p.merge_commit_sha ?? null,
  };
}
export type CloudGithubPullRequest = ReturnType<typeof projection>;

/** Stateless GitHub operations. The caller owns the connection generation,
 * workspace authorization and confirmed branch; this service never wakes a VM. */
export class CloudGithubApi {
  readonly http: CloudGithubHttp;
  constructor(private readonly options: CloudGithubHttpOptions) {
    this.http = new CloudGithubHttp(options);
  }

  withFence(assertCurrent: () => Promise<void>) {
    return new CloudGithubApi({
      ...this.options,
      assertCurrent: async () => {
        await this.options.assertCurrent();
        await assertCurrent();
      },
    });
  }

  repository(target: CloudGithubRepositoryTarget) {
    return resolveCloudGithubRepository(this.http, target);
  }

  private writeAccess(repo: CloudGithubRepositoryIdentity): void {
    if (!repo.canPush)
      throw new HttpError(
        403,
        "github_cloud_write_denied",
        "Your selected GitHub connection needs write access to this repository.",
      );
  }

  private validatePull(
    target: CloudGithubPrTarget,
    repo: CloudGithubRepositoryIdentity,
    p: Pull,
    number?: number,
  ): Pull {
    if (
      String(p.base.repo?.id) !== repo.repositoryId ||
      String(p.head.repo?.id) !== repo.repositoryId ||
      p.head.ref !== target.branch ||
      (number !== undefined && p.number !== number) ||
      p.html_url.toLowerCase() !==
        `https://github.com/${repo.repository}/pull/${p.number}`.toLowerCase()
    )
      throw identityChanged();
    return p;
  }

  async readPull(
    target: CloudGithubPrTarget,
    number: number,
    resolved?: CloudGithubRepositoryIdentity,
  ): Promise<{ repo: CloudGithubRepositoryIdentity; pull: Pull }> {
    if (!githubId.safeParse(number).success)
      throw new HttpError(422, "invalid_input", "Invalid pull request number.");
    const repo = resolved ?? (await this.repository(target));
    const pull = this.validatePull(
      target,
      repo,
      await this.http.json(`${repoPath(repo)}/pulls/${number}`, pullSchema),
      number,
    );
    return { repo, pull };
  }

  async get(target: CloudGithubPrTarget, number: number) {
    return projection((await this.readPull(target, number)).pull);
  }

  async list(
    target: CloudGithubPrTarget,
    state: "open" | "closed" | "all" = "all",
  ) {
    const repo = await this.repository(target);
    const head = `${repo.repository.split("/")[0]}:${target.branch}`;
    const rows = await this.http.pages(
      `${repoPath(repo)}/pulls?head=${encodeURIComponent(head)}&state=${state}&sort=updated&direction=desc`,
      pullSchema,
    );
    return rows
      .filter(
        (p) =>
          p.head.ref === target.branch &&
          String(p.head.repo?.id) === repo.repositoryId &&
          String(p.base.repo?.id) === repo.repositoryId,
      )
      .map((p) => projection(this.validatePull(target, repo, p)));
  }

  async find(
    target: CloudGithubPrTarget,
    state: "open" | "all" = "all",
    resolved?: CloudGithubRepositoryIdentity,
    exactBase = false,
  ) {
    const repo = resolved ?? (await this.repository(target));
    const head = `${repo.repository.split("/")[0]}:${target.branch}`;
    const rows = await this.http.pages(
      `${repoPath(repo)}/pulls?head=${encodeURIComponent(head)}&state=${state}&sort=updated&direction=desc`,
      pullSchema,
    );
    const matching = rows.filter(
      (p) =>
        p.head.ref === target.branch &&
        String(p.head.repo?.id) === repo.repositoryId &&
        String(p.base.repo?.id) === repo.repositoryId &&
        (!exactBase || p.base.ref === target.baseBranch),
    );
    const selected =
      matching.find(
        (p) => p.state === "open" && p.base.ref === target.baseBranch,
      ) ??
      matching.find((p) => p.state === "open") ??
      matching[0];
    return selected
      ? projection(this.validatePull(target, repo, selected))
      : null;
  }

  async create(
    target: CloudGithubPrTarget,
    input: { title: string; body: string; draft?: boolean | undefined },
    expectedHead?: string,
  ) {
    const repo = await this.repository(target);
    this.writeAccess(repo);
    if (
      !target.branch ||
      target.branch === "HEAD" ||
      target.branch === target.baseBranch
    )
      throw new HttpError(
        409,
        "github_branch_required",
        "Create a branch with changes before opening a pull request.",
      );
    const existing = await this.find(target, "open", repo, true);
    if (existing) return existing;
    if (expectedHead) {
      const remote = await this.http.json(
        `${repoPath(repo)}/commits/${encodeURIComponent(target.branch)}`,
        z.object({ sha: githubSha }),
      );
      if (remote.sha !== expectedHead)
        throw new HttpError(
          409,
          "github_branch_unpublished",
          "Push this workspace's current commit before creating the pull request.",
        );
    }
    try {
      const p = await this.http.json(`${repoPath(repo)}/pulls`, pullSchema, {
        method: "POST",
        body: {
          title: input.title,
          body: input.body,
          draft: input.draft ?? false,
          head: target.branch,
          base: target.baseBranch,
        },
      });
      if (p.base.ref !== target.baseBranch) throw identityChanged();
      return projection(this.validatePull(target, repo, p));
    } catch (error) {
      // A lost response or GitHub's duplicate-PR validation may follow success.
      // Reconcile the exact branch once; never replay the write automatically.
      if (
        error instanceof HttpError &&
        ["github_unavailable", "github_invalid_operation"].includes(error.code)
      ) {
        const created = await this.find(target, "open", repo, true).catch(
          () => null,
        );
        if (created) return created;
      }
      throw error;
    }
  }

  async update(
    target: CloudGithubPrTarget,
    number: number,
    input: {
      title?: string | undefined;
      body?: string | undefined;
      state?: "open" | "closed" | undefined;
      headSha?: string | undefined;
    },
  ) {
    const { repo, pull } = await this.readPull(target, number);
    this.writeAccess(repo);
    if (input.headSha && input.headSha !== pull.head.sha) throw prChanged();
    const { headSha: _headSha, ...body } = input;
    return projection(
      this.validatePull(
        target,
        repo,
        await this.http.json(`${repoPath(repo)}/pulls/${number}`, pullSchema, {
          method: "PATCH",
          body,
        }),
        number,
      ),
    );
  }

  async ready(target: CloudGithubPrTarget, number: number, headSha?: string) {
    const { repo, pull } = await this.readPull(target, number);
    this.writeAccess(repo);
    if ((headSha && headSha !== pull.head.sha) || pull.state !== "open")
      throw prChanged();
    if (!pull.draft) return projection(pull);
    const result = await this.http.request("/graphql", {
      method: "POST",
      mutation: true,
      body: {
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { id isDraft } } }",
        variables: { id: pull.node_id },
      },
    });
    const parsed = z
      .object({
        data: z.object({
          markPullRequestReadyForReview: z.object({
            pullRequest: z.object({
              id: z.literal(pull.node_id),
              isDraft: z.literal(false),
            }),
          }),
        }),
      })
      .safeParse(result);
    if (!parsed.success)
      throw new HttpError(
        403,
        "github_cloud_write_denied",
        "GitHub did not permit marking this pull request ready.",
      );
    // The mutation is confirmed; an optional refresh must not report it failed.
    return projection({ ...pull, draft: false });
  }

  async merge(
    target: CloudGithubPrTarget,
    number: number,
    input: {
      method: "squash" | "merge" | "rebase";
      headSha?: string | undefined;
      commitTitle?: string | undefined;
      commitMessage?: string | undefined;
    },
  ) {
    const { repo, pull } = await this.readPull(target, number);
    this.writeAccess(repo);
    if (input.headSha && input.headSha !== pull.head.sha) throw prChanged();
    if (pull.state !== "open" || pull.draft || pull.mergeable === false)
      throw new HttpError(
        409,
        "github_merge_blocked",
        "This pull request is not ready to merge. Check its reviews, checks and conflicts.",
      );
    const result = await this.http.json(
      `${repoPath(repo)}/pulls/${number}/merge`,
      z.object({ merged: z.boolean(), sha: githubSha }),
      {
        method: "PUT",
        body: {
          merge_method: input.method,
          sha: pull.head.sha,
          ...(input.commitTitle === undefined
            ? {}
            : { commit_title: input.commitTitle }),
          ...(input.commitMessage === undefined
            ? {}
            : { commit_message: input.commitMessage }),
        },
      },
    );
    if (!result.merged)
      throw new HttpError(
        409,
        "github_merge_blocked",
        "GitHub did not merge this pull request. Check its required checks and reviews.",
      );
    return { sha: result.sha };
  }

  private async sameRevision(
    target: CloudGithubPrTarget,
    repo: CloudGithubRepositoryIdentity,
    original: Pull,
  ) {
    const current = (await this.readPull(target, original.number, repo)).pull;
    if (
      current.head.sha !== original.head.sha ||
      current.base.sha !== original.base.sha
    )
      throw prChanged();
  }

  async diff(target: CloudGithubPrTarget, number: number) {
    const { repo, pull } = await this.readPull(target, number);
    const patch = (await this.http.request(
      `${repoPath(repo)}/pulls/${number}`,
      { text: true },
    )) as string;
    await this.sameRevision(target, repo, pull);
    return { headSha: pull.head.sha, baseSha: pull.base.sha, patch };
  }

  async lineComment(
    target: CloudGithubPrTarget,
    number: number,
    input: {
      body: string;
      path: string;
      side: "LEFT" | "RIGHT";
      line: number;
      startLine?: number | undefined;
      commitSha: string;
      baseSha: string;
    },
  ) {
    const { repo, pull } = await this.readPull(target, number);
    if (
      pull.head.sha !== input.commitSha ||
      pull.base.sha !== input.baseSha ||
      pull.state !== "open"
    )
      throw prChanged();
    return this.http
      .json(
        `${repoPath(repo)}/pulls/${number}/comments`,
        z.object({ id: githubId, html_url: z.string().url() }),
        {
          method: "POST",
          body: {
            body: input.body,
            path: input.path,
            side: input.side,
            line: input.line,
            commit_id: input.commitSha,
            ...(input.startLine !== undefined && input.startLine !== input.line
              ? { start_line: input.startLine, start_side: input.side }
              : {}),
          },
        },
      )
      .then((row) => ({ id: row.id, url: row.html_url }));
  }

  async comment(target: CloudGithubPrTarget, number: number, body: string) {
    const { repo } = await this.readPull(target, number);
    const row = await this.http.json(
      `${repoPath(repo)}/issues/${number}/comments`,
      z.object({ id: githubId, html_url: z.string().url() }),
      { method: "POST", body: { body } },
    );
    return { id: row.id, url: row.html_url };
  }

  async commits(target: CloudGithubPrTarget, number: number) {
    const { repo, pull } = await this.readPull(target, number);
    const rows = await this.http.pages(
      `${repoPath(repo)}/pulls/${number}/commits`,
      z.object({
        sha: githubSha,
        author: z
          .object({ login: githubName, avatar_url: z.string().nullable() })
          .nullable(),
        commit: z.object({
          message: z.string().max(100_000),
          author: z
            .object({ name: z.string().max(512), date: githubDate })
            .nullable(),
          committer: z.object({ date: githubDate }).nullable(),
        }),
      }),
    );
    await this.sameRevision(target, repo, pull);
    return rows.map((row) => ({
      sha: row.sha,
      abbreviatedSha: row.sha.slice(0, 7),
      message: row.commit.message,
      authorName:
        row.commit.author?.name ?? row.author?.login ?? "Deleted account",
      authorLogin: row.author?.login ?? null,
      authorAvatarUrl: row.author?.avatar_url ?? null,
      date: Date.parse(
        row.commit.author?.date ??
          row.commit.committer?.date ??
          pull.created_at,
      ),
      coAuthors: [],
      additions: null,
      deletions: null,
      changedFiles: null,
    }));
  }

  async reviews(target: CloudGithubPrTarget, number: number) {
    const { repo, pull } = await this.readPull(target, number),
      path = repoPath(repo);
    const common = {
      id: githubId,
      user: z
        .object({ login: githubName, avatar_url: z.string().nullable() })
        .nullable(),
      body: z.string().max(100_000).nullable(),
      html_url: z.string().url(),
    };
    const [reviews, comments] = await Promise.all([
      this.http.pages(
        `${path}/pulls/${number}/reviews`,
        z.object({
          ...common,
          state: z.string().max(64),
          submitted_at: githubDate.nullable().optional(),
        }),
      ),
      this.http.pages(
        `${path}/issues/${number}/comments`,
        z.object({ ...common, created_at: githubDate }),
      ),
    ]);
    await this.sameRevision(target, repo, pull);
    return [
      ...reviews
        .filter((row) => row.submitted_at && row.state !== "PENDING")
        .map((row) => ({
          kind: "review" as const,
          id: row.id,
          author: row.user?.login ?? "Deleted account",
          authorAvatarUrl: row.user?.avatar_url ?? null,
          state: row.state.toLowerCase(),
          body: row.body ?? "",
          url: row.html_url,
          createdAt: Date.parse(row.submitted_at!),
        })),
      ...comments.map((row) => ({
        kind: "comment" as const,
        id: row.id,
        author: row.user?.login ?? "Deleted account",
        authorAvatarUrl: row.user?.avatar_url ?? null,
        state: "commented",
        body: row.body ?? "",
        url: row.html_url,
        createdAt: Date.parse(row.created_at),
      })),
    ].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }

  async checks(target: CloudGithubPrTarget, number: number) {
    const { repo, pull } = await this.readPull(target, number),
      path = repoPath(repo),
      sha = pull.head.sha;
    const check = z.object({
      name: z.string().max(512),
      status: z.string().max(64),
      conclusion: z.string().max(64).nullable(),
      details_url: z.string().nullable().optional(),
      html_url: z.string().nullable().optional(),
      started_at: githubDate.nullable().optional(),
      completed_at: githubDate.nullable().optional(),
    });
    const runs: z.infer<typeof check>[] = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.http.json(
        `${path}/commits/${sha}/check-runs?per_page=100&page=${page}`,
        z.object({
          total_count: z.number().int().nonnegative(),
          check_runs: z.array(check).max(100),
        }),
      );
      runs.push(...data.check_runs);
      if (runs.length >= data.total_count) break;
      if (data.check_runs.length < 100 || page === 10)
        throw new HttpError(
          413,
          "github_results_truncated",
          "The check list is incomplete. Open it in GitHub.",
        );
    }
    const statuses = await this.http.pages(
      `${path}/commits/${sha}/statuses`,
      z.object({
        context: z.string().max(512),
        state: z.string().max(64),
        target_url: z.string().nullable(),
        description: z.string().nullable(),
      }),
    );
    const checks = runs.map((row) => ({
      name: row.name,
      status: row.status,
      conclusion: row.conclusion,
      detailsUrl: row.details_url ?? row.html_url ?? null,
      startedAt: row.started_at ? Date.parse(row.started_at) : null,
      completedAt: row.completed_at ? Date.parse(row.completed_at) : null,
    }));
    const deployments: {
        environment: string;
        state: string;
        description: string | null;
        url: string | null;
      }[] = [],
      seen = new Set<string>();
    for (const row of statuses) {
      if (seen.has(row.context)) continue;
      seen.add(row.context);
      if (/deploy|pages|vercel|netlify|cloudflare|preview/i.test(row.context))
        deployments.push({
          environment: row.context,
          state: row.state,
          description: row.description,
          url: row.target_url,
        });
      else
        checks.push({
          name: row.context,
          status: row.state === "pending" ? "in_progress" : "completed",
          conclusion: row.state === "pending" ? null : row.state,
          detailsUrl: row.target_url,
          startedAt: null,
          completedAt: null,
        });
    }
    await this.sameRevision(target, repo, pull);
    const passed = checks.filter((row) =>
      ["success", "neutral", "skipped"].includes(row.conclusion ?? ""),
    ).length;
    const failed = checks.filter((row) =>
      [
        "failure",
        "cancelled",
        "timed_out",
        "error",
        "action_required",
        "startup_failure",
        "stale",
      ].includes(row.conclusion ?? ""),
    ).length;
    return {
      checks,
      deployments,
      total: checks.length,
      passed,
      failed,
      pending: checks.length - passed - failed,
    };
  }
}
