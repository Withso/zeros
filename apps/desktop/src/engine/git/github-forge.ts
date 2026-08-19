import {
  addPrComment,
  createPr,
  getPr,
  markPrReady,
  mergePr,
  resolveGithubWorkspaceRepository,
  updatePr,
  type CreatePrOptions,
  type GetPrOptions,
  type MarkReadyOptions,
  type MergePrOptions,
  type UpdatePrOptions,
} from "./github";
import {
  assertForgeRepositoryIdentity,
  changeRequestIdentity,
  ForgeContractError,
  type ChangeRequest,
  type ChangeRequestCommentInput,
  type ChangeRequestCommentResult,
  type ChangeRequestCreateInput,
  type ChangeRequestIdentity,
  type ChangeRequestMergeInput,
  type ChangeRequestMergeResult,
  type ChangeRequestUpdateInput,
  type ForgeAdapter,
  type ForgeRepositoryIdentity,
  type GitObjectId,
} from "./forge";
import type { PR } from "./types";

interface GithubRepositoryTarget {
  owner: string;
  repo: string;
  remote?: string;
}

export interface GithubForgeOperations {
  resolveRepository(workspaceId: string): Promise<GithubRepositoryTarget>;
  create(
    input: CreatePrOptions,
    repository: GithubRepositoryTarget,
  ): Promise<PR>;
  get(input: GetPrOptions, repository: GithubRepositoryTarget): Promise<PR>;
  update(
    input: UpdatePrOptions,
    repository: GithubRepositoryTarget,
  ): Promise<PR>;
  markReady(
    input: MarkReadyOptions,
    repository: GithubRepositoryTarget,
  ): Promise<PR>;
  merge(
    input: MergePrOptions,
    repository: GithubRepositoryTarget,
  ): Promise<{ sha: string }>;
  comment(
    input: { workspaceId: string; prNumber: number; body: string },
    repository: GithubRepositoryTarget,
  ): Promise<{ id: number; url: string }>;
}

const githubOperations: GithubForgeOperations = {
  resolveRepository: resolveGithubWorkspaceRepository,
  create: createPr,
  get: getPr,
  update: updatePr,
  markReady: markPrReady,
  merge: mergePr,
  comment: addPrComment,
};

function githubRepositoryIdentity(
  repository: GithubRepositoryTarget,
): ForgeRepositoryIdentity {
  return {
    schemaVersion: 1,
    forge: "github",
    host: "github.com",
    owner: repository.owner,
    name: repository.repo,
  };
}

function gitObject(hex: string | null | undefined): GitObjectId | null {
  if (hex === null || hex === undefined || hex === "") return null;
  if (/^[a-f0-9]{40}$/.test(hex)) return { algorithm: "sha1", hex };
  if (/^[a-f0-9]{64}$/.test(hex)) return { algorithm: "sha256", hex };
  throw new ForgeContractError("GitHub returned an invalid Git object ID.");
}

function boundedText(value: string, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    /[\0]/.test(value)
  ) {
    throw new ForgeContractError(`GitHub returned an invalid ${label}.`);
  }
  return value;
}

function requestFromPr(
  repository: ForgeRepositoryIdentity,
  pr: PR,
): ChangeRequest {
  const identity = changeRequestIdentity(repository, pr.number);
  let url: URL;
  try {
    url = new URL(pr.url);
  } catch {
    throw new ForgeContractError("GitHub returned an invalid review URL.");
  }
  const expectedPath = `/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pull/${pr.number}`;
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== repository.host ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== expectedPath ||
    url.search !== "" ||
    url.hash !== "" ||
    !Number.isSafeInteger(pr.createdAt) ||
    !Number.isSafeInteger(pr.updatedAt) ||
    pr.createdAt < 0 ||
    pr.updatedAt < pr.createdAt ||
    (pr.mergedAt !== null &&
      (!Number.isSafeInteger(pr.mergedAt) || pr.mergedAt < pr.createdAt)) ||
    !["draft", "ready", "closed", "merged"].includes(pr.state) ||
    (pr.isMergeable !== null && typeof pr.isMergeable !== "boolean") ||
    (pr.behindBy !== undefined &&
      pr.behindBy !== null &&
      (!Number.isSafeInteger(pr.behindBy) || pr.behindBy < 0))
  ) {
    throw new ForgeContractError("GitHub returned malformed review state.");
  }
  return {
    schemaVersion: 1,
    identity,
    url: url.toString(),
    state: pr.state,
    title: boundedText(pr.title, "review title", 4_096),
    body: boundedText(pr.body, "review body", 1_000_000),
    author: boundedText(pr.authorLogin, "review author", 256),
    source: {
      branch: boundedText(pr.headBranch, "source branch", 1_024),
      gitObject: gitObject(pr.headSha),
    },
    target: {
      branch: boundedText(pr.baseBranch, "target branch", 1_024),
    },
    mergeability: {
      state: boundedText(pr.mergeableState, "mergeability state", 128),
      mergeable: pr.isMergeable,
    },
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    resultGitObject: gitObject(pr.mergeCommitSha),
    ...(Object.prototype.hasOwnProperty.call(pr, "behindBy")
      ? { behindBy: pr.behindBy }
      : {}),
  };
}

function providerTarget(
  repository: ForgeRepositoryIdentity,
): GithubRepositoryTarget {
  assertForgeRepositoryIdentity(repository, "github");
  if (repository.host !== "github.com") {
    throw new ForgeContractError("This adapter supports github.com only.");
  }
  return { owner: repository.owner, repo: repository.name };
}

function targetIdentity(
  repository: ForgeRepositoryIdentity,
  number: number,
): ChangeRequestIdentity {
  return changeRequestIdentity(repository, number);
}

function requestForTarget(
  repository: ForgeRepositoryIdentity,
  number: number,
  pr: PR,
): ChangeRequest {
  const expected = targetIdentity(repository, number);
  const request = requestFromPr(repository, pr);
  if (request.identity.number !== expected.number) {
    throw new ForgeContractError(
      "GitHub returned a different change request than requested.",
    );
  }
  return request;
}

export class GithubForgeAdapter implements ForgeAdapter {
  readonly id = "github" as const;

  constructor(private readonly operations = githubOperations) {}

  async resolveRepository(
    workspaceId: string,
  ): Promise<ForgeRepositoryIdentity> {
    return (await this.resolvePublicationTarget(workspaceId)).repository;
  }

  /** GitHub's current one-click creation publishes a branch before calling the
   * hosted API. Resolve both identities in one read so the raw Git operation
   * uses the same configured remote that produced the review target. */
  async resolvePublicationTarget(workspaceId: string): Promise<{
    repository: ForgeRepositoryIdentity;
    gitRemote: string;
  }> {
    const target = await this.operations.resolveRepository(workspaceId);
    const repository = githubRepositoryIdentity(target);
    assertForgeRepositoryIdentity(repository, "github");
    if (
      typeof target.remote !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(target.remote) ||
      target.remote.startsWith("-") ||
      target.remote.includes("..")
    ) {
      throw new ForgeContractError("GitHub Git remote identity is invalid.");
    }
    return {
      repository,
      gitRemote: target.remote,
    };
  }

  async create(input: ChangeRequestCreateInput): Promise<ChangeRequest> {
    const repository = providerTarget(input.repository);
    return requestFromPr(
      input.repository,
      await this.operations.create(
        {
          workspaceId: input.workspaceId,
          title: input.title,
          body: input.body,
          draft: input.draft,
        },
        repository,
      ),
    );
  }

  async get(input: {
    workspaceId: string;
    repository: ForgeRepositoryIdentity;
    number: number;
  }): Promise<ChangeRequest> {
    const repository = providerTarget(input.repository);
    targetIdentity(input.repository, input.number);
    return requestForTarget(
      input.repository,
      input.number,
      await this.operations.get(
        { workspaceId: input.workspaceId, prNumber: input.number },
        repository,
      ),
    );
  }

  async update(input: ChangeRequestUpdateInput): Promise<ChangeRequest> {
    const repository = providerTarget(input.repository);
    targetIdentity(input.repository, input.number);
    return requestForTarget(
      input.repository,
      input.number,
      await this.operations.update(
        {
          workspaceId: input.workspaceId,
          prNumber: input.number,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        },
        repository,
      ),
    );
  }

  async markReady(input: {
    workspaceId: string;
    repository: ForgeRepositoryIdentity;
    number: number;
  }): Promise<ChangeRequest> {
    const repository = providerTarget(input.repository);
    targetIdentity(input.repository, input.number);
    return requestForTarget(
      input.repository,
      input.number,
      await this.operations.markReady(
        { workspaceId: input.workspaceId, prNumber: input.number },
        repository,
      ),
    );
  }

  async merge(
    input: ChangeRequestMergeInput,
  ): Promise<ChangeRequestMergeResult> {
    const repository = providerTarget(input.repository);
    targetIdentity(input.repository, input.number);
    const result = await this.operations.merge(
      {
        workspaceId: input.workspaceId,
        prNumber: input.number,
        method: input.method,
        ...(input.commitTitle !== undefined
          ? { commitTitle: input.commitTitle }
          : {}),
        ...(input.commitMessage !== undefined
          ? { commitMessage: input.commitMessage }
          : {}),
      },
      repository,
    );
    const resultGitObject = gitObject(result.sha);
    if (!resultGitObject) {
      throw new ForgeContractError("GitHub returned no merge object ID.");
    }
    return {
      schemaVersion: 1,
      identity: targetIdentity(input.repository, input.number),
      resultGitObject,
    };
  }

  async comment(
    input: ChangeRequestCommentInput,
  ): Promise<ChangeRequestCommentResult> {
    const repository = providerTarget(input.repository);
    targetIdentity(input.repository, input.number);
    const result = await this.operations.comment(
      {
        workspaceId: input.workspaceId,
        prNumber: input.number,
        body: input.body,
      },
      repository,
    );
    if (!Number.isSafeInteger(result.id) || result.id < 1) {
      throw new ForgeContractError("GitHub returned an invalid comment ID.");
    }
    let url: URL;
    try {
      url = new URL(result.url);
    } catch {
      throw new ForgeContractError("GitHub returned an invalid comment URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== input.repository.host ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      (url.pathname !==
        `/${input.repository.owner}/${input.repository.name}/pull/${input.number}` &&
        url.pathname !==
          `/${input.repository.owner}/${input.repository.name}/issues/${input.number}`) ||
      url.hash !== `#issuecomment-${result.id}`
    ) {
      throw new ForgeContractError("GitHub returned an invalid comment URL.");
    }
    return {
      schemaVersion: 1,
      identity: targetIdentity(input.repository, input.number),
      providerCommentId: String(result.id),
      url: url.toString(),
    };
  }
}

export const githubForgeAdapter = new GithubForgeAdapter();
