import type { PR, PrState } from "./types";

export type ForgeId = "github" | "gitlab" | "bitbucket" | "origin";

/** Exact Git object identity used by the provider-neutral review boundary. */
export interface GitObjectId {
  algorithm: "sha1" | "sha256";
  hex: string;
}

export interface ForgeRepositoryIdentity {
  schemaVersion: 1;
  forge: ForgeId;
  /** Lowercase DNS host, without a port. */
  host: string;
  /** Forge-native namespace. The semantic workspace ID never embeds this. */
  owner: string;
  name: string;
}

export interface ChangeRequestIdentity {
  schemaVersion: 1;
  repository: ForgeRepositoryIdentity;
  number: number;
}

/** Provider-neutral review identity and state. Git commits remain separate:
 * this model points at exact objects but never transports or integrates them. */
export interface ChangeRequest {
  schemaVersion: 1;
  identity: ChangeRequestIdentity;
  url: string;
  state: PrState;
  title: string;
  body: string;
  author: string;
  source: { branch: string; gitObject: GitObjectId | null };
  target: { branch: string };
  mergeability: { state: string; mergeable: boolean | null };
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  resultGitObject: GitObjectId | null;
  behindBy?: number | null;
}

interface ChangeRequestTarget {
  workspaceId: string;
  repository: ForgeRepositoryIdentity;
  number: number;
}

export interface ChangeRequestCreateInput {
  workspaceId: string;
  repository: ForgeRepositoryIdentity;
  title: string;
  body: string;
  draft: boolean;
}

export interface ChangeRequestUpdateInput extends ChangeRequestTarget {
  title?: string;
  body?: string;
}

export interface ChangeRequestMergeInput extends ChangeRequestTarget {
  method: "squash" | "merge" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}

export interface ChangeRequestMergeResult {
  schemaVersion: 1;
  identity: ChangeRequestIdentity;
  resultGitObject: GitObjectId;
}

export interface ChangeRequestCommentInput extends ChangeRequestTarget {
  body: string;
}

export interface ChangeRequestCommentResult {
  schemaVersion: 1;
  identity: ChangeRequestIdentity;
  providerCommentId: string;
  url: string;
}

export interface ForgeAdapter {
  readonly id: ForgeId;
  resolveRepository(workspaceId: string): Promise<ForgeRepositoryIdentity>;
  create(input: ChangeRequestCreateInput): Promise<ChangeRequest>;
  get(input: ChangeRequestTarget): Promise<ChangeRequest>;
  update(input: ChangeRequestUpdateInput): Promise<ChangeRequest>;
  markReady(input: ChangeRequestTarget): Promise<ChangeRequest>;
  merge(input: ChangeRequestMergeInput): Promise<ChangeRequestMergeResult>;
  comment(
    input: ChangeRequestCommentInput,
  ): Promise<ChangeRequestCommentResult>;
}

export class ForgeContractError extends Error {
  readonly code = "FORGE_CONTRACT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ForgeContractError";
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

export function assertForgeRepositoryIdentity(
  value: ForgeRepositoryIdentity,
  expectedForge?: ForgeId,
): void {
  if (
    value.schemaVersion !== 1 ||
    (expectedForge !== undefined && value.forge !== expectedForge) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z0-9](?:[a-z0-9-]{0,62})$/.test(
      value.host,
    ) ||
    !SAFE_SEGMENT.test(value.owner) ||
    !SAFE_SEGMENT.test(value.name)
  ) {
    throw new ForgeContractError("Forge repository identity is invalid.");
  }
}

export function changeRequestIdentity(
  repository: ForgeRepositoryIdentity,
  number: number,
): ChangeRequestIdentity {
  assertForgeRepositoryIdentity(repository);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new ForgeContractError("Change-request number is invalid.");
  }
  return { schemaVersion: 1, repository, number };
}

export function changeRequestToLegacyPr(request: ChangeRequest): PR {
  return {
    number: request.identity.number,
    url: request.url,
    state: request.state,
    title: request.title,
    body: request.body,
    authorLogin: request.author,
    baseBranch: request.target.branch,
    headBranch: request.source.branch,
    ...(request.source.gitObject
      ? { headSha: request.source.gitObject.hex }
      : {}),
    mergeableState: request.mergeability.state,
    isMergeable: request.mergeability.mergeable,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    mergedAt: request.mergedAt,
    mergeCommitSha: request.resultGitObject?.hex ?? null,
    ...(Object.prototype.hasOwnProperty.call(request, "behindBy")
      ? { behindBy: request.behindBy }
      : {}),
  };
}
