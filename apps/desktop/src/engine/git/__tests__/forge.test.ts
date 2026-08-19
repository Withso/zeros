import { describe, expect, it, vi } from "vitest";

import type { PR } from "../types";
import {
  changeRequestToLegacyPr,
  ForgeContractError,
  type ForgeRepositoryIdentity,
} from "../forge";
import {
  GithubForgeAdapter,
  type GithubForgeOperations,
} from "../github-forge";

const REPOSITORY: ForgeRepositoryIdentity = {
  schemaVersion: 1,
  forge: "github",
  host: "github.com",
  owner: "zeros-dev",
  name: "zeros",
};

function pullRequest(overrides: Partial<PR> = {}): PR {
  return {
    number: 42,
    url: "https://github.com/zeros-dev/zeros/pull/42",
    state: "draft",
    title: "Visual option",
    body: "Rendered and verified.",
    authorLogin: "designer",
    baseBranch: "main",
    headBranch: "zeros/visual-option",
    headSha: "a".repeat(40),
    mergeableState: "clean",
    isMergeable: true,
    createdAt: 1_000,
    updatedAt: 2_000,
    mergedAt: null,
    mergeCommitSha: null,
    behindBy: 0,
    ...overrides,
  };
}

function operations(): {
  operations: GithubForgeOperations;
  calls: Record<keyof GithubForgeOperations, ReturnType<typeof vi.fn>>;
} {
  const calls = {
    resolveRepository: vi.fn(async () => ({
      owner: REPOSITORY.owner,
      repo: REPOSITORY.name,
      remote: "origin",
    })),
    create: vi.fn(async () => pullRequest()),
    get: vi.fn(async () => pullRequest()),
    update: vi.fn(async () => pullRequest({ title: "Updated" })),
    markReady: vi.fn(async () => pullRequest({ state: "ready" })),
    merge: vi.fn(async () => ({ sha: "b".repeat(40) })),
    comment: vi.fn(async () => ({
      id: 7,
      url: "https://github.com/zeros-dev/zeros/pull/42#issuecomment-7",
    })),
  };
  return {
    operations: calls as unknown as GithubForgeOperations,
    calls,
  };
}

describe("GitHub forge adapter contract", () => {
  it("keeps one stable internal ChangeRequest identity across hosted operations", async () => {
    const fake = operations();
    const forge = new GithubForgeAdapter(fake.operations);
    const repository = await forge.resolveRepository("workspace-a");
    expect(repository).toEqual(REPOSITORY);
    await expect(
      forge.resolvePublicationTarget("workspace-a"),
    ).resolves.toEqual({ repository: REPOSITORY, gitRemote: "origin" });

    const created = await forge.create({
      workspaceId: "workspace-a",
      repository,
      title: "Visual option",
      body: "Rendered and verified.",
      draft: true,
    });
    expect(created).toMatchObject({
      schemaVersion: 1,
      identity: {
        schemaVersion: 1,
        repository: REPOSITORY,
        number: 42,
      },
      source: {
        branch: "zeros/visual-option",
        gitObject: { algorithm: "sha1", hex: "a".repeat(40) },
      },
      target: { branch: "main" },
    });
    expect(changeRequestToLegacyPr(created)).toEqual(pullRequest());

    await expect(
      forge.get({ workspaceId: "workspace-a", repository, number: 42 }),
    ).resolves.toMatchObject({ identity: created.identity });
    await expect(
      forge.update({
        workspaceId: "workspace-a",
        repository,
        number: 42,
        title: "Updated",
      }),
    ).resolves.toMatchObject({ title: "Updated" });
    await expect(
      forge.markReady({ workspaceId: "workspace-a", repository, number: 42 }),
    ).resolves.toMatchObject({ state: "ready" });
    await expect(
      forge.merge({
        workspaceId: "workspace-a",
        repository,
        number: 42,
        method: "squash",
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      identity: created.identity,
      resultGitObject: { algorithm: "sha1", hex: "b".repeat(40) },
    });
    await expect(
      forge.comment({
        workspaceId: "workspace-a",
        repository,
        number: 42,
        body: "Looks good.",
      }),
    ).resolves.toEqual({
      schemaVersion: 1,
      identity: created.identity,
      providerCommentId: "7",
      url: "https://github.com/zeros-dev/zeros/pull/42#issuecomment-7",
    });

    // Every hosted call receives the already-resolved target. Raw Git branch
    // publication is deliberately absent from the forge operation contract.
    expect(fake.calls.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-a" }),
      { owner: "zeros-dev", repo: "zeros" },
    );
  });

  it.each([
    ["wrong host", { url: "https://example.com/zeros-dev/zeros/pull/42" }],
    ["wrong number", { url: "https://github.com/zeros-dev/zeros/pull/41" }],
    [
      "review URL fragment",
      { url: "https://github.com/zeros-dev/zeros/pull/42#unexpected" },
    ],
    ["malformed head object", { headSha: "not-an-object" }],
    ["malformed mergeability", { isMergeable: "yes" }],
    ["time reversal", { createdAt: 3_000, updatedAt: 2_000 }],
  ])("fails closed on provider output with %s", async (_label, override) => {
    const fake = operations();
    fake.calls.get.mockResolvedValueOnce(pullRequest(override as Partial<PR>));
    const forge = new GithubForgeAdapter(fake.operations);

    await expect(
      forge.get({
        workspaceId: "workspace-a",
        repository: REPOSITORY,
        number: 42,
      }),
    ).rejects.toBeInstanceOf(ForgeContractError);
  });

  it("fails closed when repository resolution returns an invalid identity", async () => {
    const fake = operations();
    fake.calls.resolveRepository.mockResolvedValueOnce({
      owner: "../escape",
      repo: "zeros",
      remote: "origin",
    });
    const forge = new GithubForgeAdapter(fake.operations);

    await expect(
      forge.resolvePublicationTarget("workspace-a"),
    ).rejects.toBeInstanceOf(ForgeContractError);
  });

  it("rejects comment URLs with unexpected query state", async () => {
    const fake = operations();
    fake.calls.comment.mockResolvedValueOnce({
      id: 7,
      url: "https://github.com/zeros-dev/zeros/pull/42?page=2#issuecomment-7",
    });
    const forge = new GithubForgeAdapter(fake.operations);

    await expect(
      forge.comment({
        workspaceId: "workspace-a",
        repository: REPOSITORY,
        number: 42,
        body: "Looks good.",
      }),
    ).rejects.toBeInstanceOf(ForgeContractError);
  });

  it("rejects mismatched repository bindings before a hosted API call", async () => {
    const fake = operations();
    const forge = new GithubForgeAdapter(fake.operations);
    await expect(
      forge.get({
        workspaceId: "workspace-a",
        repository: { ...REPOSITORY, forge: "gitlab" },
        number: 42,
      }),
    ).rejects.toBeInstanceOf(ForgeContractError);
    expect(fake.calls.get).not.toHaveBeenCalled();
  });

  it("rejects a mismatched response number before publishing it internally", async () => {
    const fake = operations();
    fake.calls.get.mockResolvedValueOnce(
      pullRequest({
        number: 43,
        url: "https://github.com/zeros-dev/zeros/pull/43",
      }),
    );
    const forge = new GithubForgeAdapter(fake.operations);
    await expect(
      forge.get({
        workspaceId: "workspace-a",
        repository: REPOSITORY,
        number: 42,
      }),
    ).rejects.toBeInstanceOf(ForgeContractError);
  });

  it("rejects a mismatched repository response from create", async () => {
    const fake = operations();
    fake.calls.create.mockResolvedValueOnce(
      pullRequest({
        url: "https://github.com/other-owner/zeros/pull/42",
      }),
    );
    const forge = new GithubForgeAdapter(fake.operations);

    await expect(
      forge.create({
        workspaceId: "workspace-a",
        repository: REPOSITORY,
        title: "Visual option",
        body: "Rendered and verified.",
        draft: true,
      }),
    ).rejects.toBeInstanceOf(ForgeContractError);
  });
});
