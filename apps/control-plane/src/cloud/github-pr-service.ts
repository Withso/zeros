import { HttpError } from "../authz.js";
import { CloudGithubApi, type CloudGithubPullRequest } from "./github-api.js";
import { CloudGithubReviewApi } from "./github-review-api.js";
import {
  CLOUD_GITHUB_PR_WRITES,
  CloudGithubPrRequestSchema,
  type CloudGithubPrAuthority,
  type CloudGithubPrRequest,
} from "./github-pr-contract.js";
import type { CloudGithubRepositoryIdentity } from "./github-http.js";

export interface CloudGithubPrContext {
  workspaceId: string;
  organizationId: string;
  creatorUserId: string;
  repository: string;
  repositoryId: string | null;
  branch: string | null;
  baseBranch: string;
  headSha: string | null;
  revision: string;
}
export interface CloudGithubPrAccess {
  api: CloudGithubApi;
  login?: string;
  generation: string;
  assertCurrent(): Promise<void>;
}
export interface CloudGithubPrDependencies {
  /** Reads and verifies creator, membership, source access and current metadata. */
  context(workspaceId: string, userId: string): Promise<CloudGithubPrContext>;
  access(context: CloudGithubPrContext): Promise<CloudGithubPrAccess>;
  /** Reconciles canonical metadata only; original checkout and source scope stay fixed. */
  repository(
    context: CloudGithubPrContext,
    identity: CloudGithubRepositoryIdentity,
    access: CloudGithubPrAccess,
  ): Promise<void>;
  recordPr(
    context: CloudGithubPrContext,
    pr: CloudGithubPullRequest | null,
    access: CloudGithubPrAccess,
  ): Promise<void>;
  mutate<T>(
    workspaceId: string,
    userId: string,
    action: () => Promise<T>,
  ): Promise<T>;
}
const changed = () =>
  new HttpError(
    409,
    "github_authorization_changed",
    "Your GitHub connection or workspace changed. Refresh before continuing.",
  );

/** All published PR data uses HTTPS and the creator's selected user credential.
 * Neither reads nor GitHub API writes start a worker or touch its checkout. */
export class CloudGithubPrService {
  constructor(private readonly deps: CloudGithubPrDependencies) {}

  async execute(workspaceId: string, userId: string, value: unknown) {
    const parsed = CloudGithubPrRequestSchema.safeParse(value);
    if (!parsed.success)
      throw new HttpError(
        422,
        "invalid_input",
        "Invalid cloud pull request action.",
      );
    const request = parsed.data;
    return CLOUD_GITHUB_PR_WRITES.has(request.op)
      ? this.deps.mutate(workspaceId, userId, () =>
          this.run(workspaceId, userId, request),
        )
      : this.run(workspaceId, userId, request);
  }

  private async run(
    workspaceId: string,
    userId: string,
    request: CloudGithubPrRequest,
  ) {
    const context = await this.deps.context(workspaceId, userId);
    if (context.workspaceId !== workspaceId || context.creatorUserId !== userId)
      throw new HttpError(404, "not_found", "Cloud workspace not found.");
    if (!context.branch)
      throw new HttpError(
        409,
        "github_checkout_unavailable",
        "Open this workspace on a branch to enable pull requests.",
      );
    const access = await this.deps.access(context);
    const target = {
      repository: context.repository,
      repositoryId: context.repositoryId,
      branch: context.branch,
      baseBranch: context.baseBranch,
    };
    const identity = await access.api.repository(target);
    const authority: CloudGithubPrAuthority = {
      connectionGeneration: access.generation,
      repositoryId: identity.repositoryId,
      repository: identity.repository,
      branch: context.branch,
      baseBranch: context.baseBranch,
      contextRevision: context.revision,
    };
    if (
      request.expected &&
      Object.keys(authority).some(
        (key) =>
          authority[key as keyof CloudGithubPrAuthority] !==
          request.expected![key as keyof CloudGithubPrAuthority],
      )
    )
      throw changed();
    await this.deps.repository(context, identity, access);
    const assertCurrent = async () => {
      await access.assertCurrent();
      const current = await this.deps.context(workspaceId, userId);
      if (
        current.workspaceId !== context.workspaceId ||
        current.organizationId !== context.organizationId ||
        current.creatorUserId !== userId ||
        current.revision !== context.revision ||
        current.branch !== context.branch ||
        current.baseBranch !== context.baseBranch ||
        (current.repositoryId && current.repositoryId !== identity.repositoryId)
      )
        throw changed();
    };
    const canonical = {
      ...target,
      repository: identity.repository,
      repositoryId: identity.repositoryId,
    };
    const api = access.api.withFence(assertCurrent);
    const review = new CloudGithubReviewApi(api);
    await assertCurrent();
    // Exact revisions are mandatory for every mutation of an existing PR.
    if (
      CLOUD_GITHUB_PR_WRITES.has(request.op) &&
      "prNumber" in request.params &&
      "headSha" in request.params
    ) {
      const current = await api.get(canonical, request.params.prNumber);
      if (
        current.headSha !== request.params.headSha ||
        current.baseSha !== request.params.baseSha
      )
        throw new HttpError(
          409,
          "github_pr_changed",
          "The pull request changed. Refresh before applying this action.",
        );
      await assertCurrent();
    }
    let result: unknown;
    let remembered: CloudGithubPullRequest | null | undefined;
    switch (request.op) {
      case "gh.authStatus":
        result = {
          authenticated: true,
          ...(access.login ? { login: access.login } : {}),
        };
        break;
      case "gh.repoAccess":
        result = identity.canPush
          ? { state: "ok", connected: true }
          : {
              state: "blocked",
              connected: true,
              code: "GITHUB_FORBIDDEN_SCOPE",
              message: "This GitHub connection cannot push to this repository.",
              remediation:
                "Ask for write access on GitHub, or select a connection that has it.",
            };
        break;
      case "gh.prSync": {
        if (request.params.url) {
          const url = new URL(request.params.url),
            match = /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(
              url.pathname,
            );
          if (
            !match ||
            match[1]!.toLowerCase() !== identity.repository.toLowerCase()
          )
            throw new HttpError(
              409,
              "github_pr_identity_changed",
              "The pull request URL does not match this workspace repository.",
            );
          remembered = await api.get(canonical, Number(match[2]));
        } else remembered = await api.find(canonical);
        result = remembered;
        break;
      }
      case "gh.prGet":
        remembered = await api.get(canonical, request.params.prNumber);
        result = remembered;
        break;
      case "gh.prList":
        result = await api.list(canonical, request.params.state);
        break;
      case "gh.prChecks":
        result = await api.checks(canonical, request.params.prNumber);
        break;
      case "gh.prCommits":
        result = await api.commits(canonical, request.params.prNumber);
        break;
      case "gh.prReviews":
        result = await api.reviews(canonical, request.params.prNumber);
        break;
      case "gh.prInlineReview":
        result = await review.get(canonical, request.params.prNumber);
        break;
      case "gh.prReviewDiff":
        result = await api.diff(canonical, request.params.prNumber);
        break;
      case "gh.prCreate": {
        if (!context.headSha)
          throw new HttpError(
            409,
            "github_checkout_unavailable",
            "Confirm and push the workspace branch before creating its pull request.",
          );
        remembered = await api.create(
          canonical,
          request.params,
          context.headSha,
        );
        result = remembered;
        break;
      }
      case "gh.prUpdate": {
        const { prNumber, baseSha: _baseSha, ...input } = request.params;
        remembered = await api.update(canonical, prNumber, input);
        result = remembered;
        break;
      }
      case "gh.prMarkReady":
        remembered = await api.ready(
          canonical,
          request.params.prNumber,
          request.params.headSha,
        );
        result = remembered;
        break;
      case "gh.prMerge":
        result = await api.merge(
          canonical,
          request.params.prNumber,
          request.params,
        );
        break;
      case "gh.prComment": {
        const p = request.params;
        if (p.kind === "line") {
          if (p.startLine !== undefined && p.startLine > p.line)
            throw new HttpError(
              422,
              "invalid_input",
              "The comment range must end after it starts.",
            );
          result = await api.lineComment(canonical, p.prNumber, {
            ...p,
            commitSha: p.headSha,
          });
        } else if (p.kind === "reply")
          result = await review.reply(canonical, p.prNumber, p);
        else if (p.kind === "resolve")
          result = await review.resolve(canonical, p.prNumber, p);
        else result = await api.comment(canonical, p.prNumber, p.body);
        break;
      }
    }
    const write = CLOUD_GITHUB_PR_WRITES.has(request.op);
    try {
      await assertCurrent();
    } catch (error) {
      if (!write) throw error;
      return { authority, authorityCurrent: false, result };
    }
    if (remembered !== undefined) {
      if (CLOUD_GITHUB_PR_WRITES.has(request.op)) {
        // GitHub already confirmed the public mutation. The next status read
        // repairs metadata if this optional catalog update is unavailable.
        await this.deps.recordPr(context, remembered, access).catch(() => {});
      } else await this.deps.recordPr(context, remembered, access);
    }
    return { authority, result };
  }
}
