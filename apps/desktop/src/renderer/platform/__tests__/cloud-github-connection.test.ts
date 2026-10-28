import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  request: vi.fn(),
  account: 1,
  clearPr: vi.fn(),
}));
vi.mock("../cloud-workspaces", () => ({ cloudAccountRequest: f.request }));
vi.mock("../cloud-github-pr", () => ({ clearCloudGithubPr: f.clearPr }));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => f.account,
}));
import {
  beginCloudGithubConnection,
  changeCloudGithubConnection,
  clearCloudGithubConnections,
  cloudGithubConnectionCache,
  cloudGithubConnectionKey,
  cloudGithubRepositoryPageCache,
  readCloudGithubConnection,
  readSelectedCloudRepositories,
} from "../cloud-github-connection";

const user = "11111111-1111-4111-8111-111111111111",
  org = "22222222-2222-4222-8222-222222222222";
const generation = "a".repeat(64),
  next = "b".repeat(64),
  key = cloudGithubConnectionKey(user, org);
const snapshot = {
  generation,
  selectedMethod: "pat",
  methods: {
    pat: { configured: true, health: "connected", login: "contributor" },
    "github-app": { configured: false, health: "not-connected" },
  },
  appAvailable: true,
  installUrl: "https://github.com/apps/example/installations/new",
};
beforeEach(() => {
  clearCloudGithubConnections();
  vi.clearAllMocks();
  f.account = 1;
  f.request.mockResolvedValue(snapshot);
});
it("loads cloud status over HTTPS without consulting native Local authentication", async () => {
  await expect(readCloudGithubConnection(user, org)).resolves.toEqual(snapshot);
  expect(f.request.mock.calls[0]?.[0]).toBe(
    `/v1/cloud-v2/github/connection?organizationId=${org}`,
  );
});
it("fences late account A to B to A responses", async () => {
  let finish!: (value: unknown) => void;
  f.request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = readCloudGithubConnection(user, org);
  f.account += 2;
  finish(snapshot);
  await expect(pending).rejects.toThrow(/changed/);
});
it("keeps repository and PR state scoped to the selected connection generation", async () => {
  await readCloudGithubConnection(user, org);
  const repoKey = JSON.stringify([key, generation, 1]);
  cloudGithubRepositoryPageCache.setData(repoKey, {
    generation,
    repositories: [],
    nextPage: null,
    complete: true,
  });
  f.request.mockResolvedValue({
    ...snapshot,
    generation: next,
    selectedMethod: "github-app",
    methods: {
      ...snapshot.methods,
      "github-app": { configured: true, health: "connected", login: "another" },
    },
  });
  await readCloudGithubConnection(user, org);
  expect(
    cloudGithubRepositoryPageCache.peekSnapshot(repoKey).data,
  ).toBeUndefined();
  expect(f.clearPr).toHaveBeenCalledWith(org);
  await expect(
    readSelectedCloudRepositories(user, org, generation),
  ).rejects.toThrow(/changed/);
});
it("does not accept a repository page completed after method selection", async () => {
  await readCloudGithubConnection(user, org);
  let finish!: (value: unknown) => void;
  f.request.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = readSelectedCloudRepositories(user, org, generation);
  f.request.mockResolvedValue({ ...snapshot, generation: next });
  await changeCloudGithubConnection(user, org, generation, {
    action: "select",
    method: "github-app",
  });
  finish({ generation, repositories: [], nextPage: null, complete: true });
  await expect(pending).rejects.toThrow(/changed/);
});
it("never stores the personal token in a cache key or status snapshot", async () => {
  await changeCloudGithubConnection(user, org, generation, {
    action: "pat",
    token: "synthetic-sensitive-value",
  });
  expect(
    JSON.stringify([
      ...cloudGithubConnectionCache.keys(),
      cloudGithubConnectionCache.peekSnapshot(key).data,
    ]),
  ).not.toContain("synthetic-sensitive-value");
  expect(f.request.mock.calls[0]?.[2].body).toEqual({
    organizationId: org,
    expected: generation,
    action: "pat",
    token: "synthetic-sensitive-value",
  });
});
it("starts an independent cloud OAuth flow and retains its generation", async () => {
  f.request.mockResolvedValue({
    url: "https://github.com/login/oauth/authorize",
    generation: next,
  });
  await expect(
    beginCloudGithubConnection(user, org, generation),
  ).resolves.toMatchObject({ generation: next });
  expect(f.request.mock.calls[0]?.[2].body.action).toBe("oauth");
});
