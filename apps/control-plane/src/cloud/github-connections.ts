import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../authz.js";
import type { GithubBackendConfig } from "../config.js";
import type { Tx } from "../db.js";
import { exchangeGithubToken } from "../github.js";
import type { RepositoryRequest } from "../github-repository-authority.js";
import { CloudGithubApi } from "./github-api.js";
import {
  CloudGithubHttp,
  githubId,
  githubName,
  githubRepositorySchema,
  type CloudGithubRepositoryTarget,
  type CloudGithubRepositoryIdentity,
} from "./github-http.js";
import {
  CloudGithubConnectionStore,
  type CloudGithubConnectionScope,
  type CloudGithubAccount,
} from "./github-connections-store.js";
import {
  CloudGithubCredentialSchema,
  type CloudGithubCredential,
} from "./github-credential-envelope.js";

const changed = () =>
  new HttpError(
    409,
    "github_authorization_changed",
    "Your cloud GitHub connection changed. Refresh before continuing.",
  );
const profile = z.object({ id: githubId, login: githubName });
type AppCredential = Extract<CloudGithubCredential, { method: "github-app" }>;
export type CloudGithubConnectionHealth =
  | "connected"
  | "not-connected"
  | "expired"
  | "invalid"
  | "not-installed"
  | "sso-required"
  | "rate-limited"
  | "unavailable";

/** Direct user-token requests let GitHub enforce the intersection of the human,
 * App/PAT permissions, SSO, and repository selection. Installation tokens are
 * used separately for narrowed VM Git; they never author a user's PR action. */
export class CloudGithubConnections {
  constructor(
    readonly store: CloudGithubConnectionStore,
    readonly config: GithubBackendConfig | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly repositoryTarget: (
      scope: CloudGithubConnectionScope,
      repository: string,
    ) => Promise<CloudGithubRepositoryTarget> = async (_scope, repository) => ({
      repository,
    }),
  ) {}

  private http(token: string, assertCurrent: () => Promise<void>) {
    return new CloudGithubHttp({
      apiBaseUrl: this.config?.apiBaseUrl ?? "https://api.github.com",
      token,
      assertCurrent,
      fetch: this.fetchImpl,
    });
  }
  private async identity(
    token: string,
    assertCurrent: () => Promise<void>,
  ): Promise<CloudGithubAccount> {
    const user = await this.http(token, assertCurrent).json("/user", profile);
    return { id: String(user.id), login: user.login };
  }
  private async refresh(
    credential: AppCredential,
    account: CloudGithubAccount,
  ): Promise<AppCredential> {
    const config = this.requireApp();
    const bundle = await exchangeGithubToken(
      this.fetchImpl,
      config,
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: credential.refreshToken,
      }),
      Date.now(),
    );
    const identity = await this.identity(bundle.accessToken, async () => {});
    if (identity.id !== account.id) throw changed();
    return {
      method: "github-app",
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      expiresAt: bundle.expiresAtMs,
      refreshExpiresAt: bundle.refreshTokenExpiresAtMs,
    };
  }
  async access(scope: CloudGithubConnectionScope) {
    const snapshot = await this.store.credential(scope, (credential, account) =>
      this.refresh(credential, account),
    );
    const identity = await this.identity(
      snapshot.material.accessToken,
      snapshot.assertCurrent,
    );
    if (identity.id !== snapshot.identity.id) throw changed();
    return {
      ...snapshot,
      identity,
      login: identity.login,
      api: new CloudGithubApi({
        apiBaseUrl: this.config?.apiBaseUrl ?? "https://api.github.com",
        token: snapshot.material.accessToken,
        assertCurrent: snapshot.assertCurrent,
        fetch: this.fetchImpl,
      }),
    };
  }
  async connectPat(
    scope: CloudGithubConnectionScope,
    expected: string,
    token: string,
  ): Promise<void> {
    const material = CloudGithubCredentialSchema.safeParse({
      method: "pat",
      accessToken: token,
      expiresAt: null,
    });
    if (!material.success)
      throw new HttpError(
        422,
        "invalid_input",
        "Enter a valid GitHub personal access token.",
      );
    const identity = await this.identity(token, () =>
      this.store.assertCurrent(scope, expected),
    );
    await this.store.save(scope, expected, identity, material.data);
  }
  private requireApp(): GithubBackendConfig {
    if (!this.config)
      throw new HttpError(
        503,
        "github_not_configured",
        "GitHub App sign-in is unavailable. Use a personal token or try again later.",
      );
    return this.config;
  }
  async begin(
    scope: CloudGithubConnectionScope,
    expected: string,
  ): Promise<{ url: string; generation: string }> {
    const config = this.requireApp(),
      state = `zcg_${randomBytes(32).toString("base64url")}`,
      verifier = randomBytes(32).toString("base64url");
    const generation = await this.store.beginOauth(
      scope,
      expected,
      state,
      verifier,
    );
    const url = new URL("/login/oauth/authorize", config.webBaseUrl);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.oauthCallbackUrl,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return { url: url.toString(), generation };
  }
  async callback(
    state: string,
    code: string | undefined,
    denied: boolean,
  ): Promise<void> {
    const pending = await this.store.consumeOauth(state);
    try {
      const config = this.requireApp();
      if (denied || !code || code.length > 1024)
        throw new HttpError(
          422,
          "github_oauth_cancelled",
          "GitHub sign-in was cancelled. Return to Zeros to try again.",
        );
      const bundle = await exchangeGithubToken(
        this.fetchImpl,
        config,
        new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.oauthCallbackUrl,
          code,
          code_verifier: pending.verifier,
        }),
        Date.now(),
      );
      const identity = await this.identity(bundle.accessToken, () =>
        this.store.assertCurrent(pending.scope, pending.expected),
      );
      await this.store.save(pending.scope, pending.expected, identity, {
        method: "github-app",
        accessToken: bundle.accessToken,
        refreshToken: bundle.refreshToken,
        expiresAt: bundle.expiresAtMs,
        refreshExpiresAt: bundle.refreshTokenExpiresAtMs,
      });
    } catch (error) {
      // Consumed state cannot complete later. Retire only this attempt so the
      // desktop stops waiting, preserving a newer attempt and saved methods.
      try {
        await this.store.cancelOauth(pending.scope, pending.expected);
      } catch {
        /* A newer generation owns the connection. */
      }
      throw error;
    }
  }
  async status(scope: CloudGithubConnectionScope) {
    const status = await this.store.status(scope);
    let health: CloudGithubConnectionHealth | undefined;
    let login: string | undefined;
    if (status.selectedMethod) {
      try {
        const access = await this.access(scope);
        if (access.generation !== status.generation) throw changed();
        login = access.identity.login;
        health = "connected";
        if (status.selectedMethod === "github-app") {
          const installations = await access.api.http.json(
            "/user/installations?per_page=1",
            z.object({ total_count: z.number().int().nonnegative() }),
          );
          if (!installations.total_count) health = "not-installed";
        }
      } catch (error) {
        if (
          error instanceof HttpError &&
          ["github_authorization_changed", "not_found"].includes(error.code)
        )
          throw error;
        health =
          error instanceof HttpError &&
          error.code === "github_authorization_expired"
            ? "expired"
            : error instanceof HttpError && error.code === "github_sso_required"
              ? "sso-required"
              : error instanceof HttpError &&
                  error.code === "github_rate_limited"
                ? "rate-limited"
                : error instanceof HttpError && error.status === 403
                  ? "invalid"
                  : "unavailable";
      }
    }
    await this.store.assertCurrent(scope, status.generation);
    return {
      ...status,
      methods: {
        ...status.methods,
        ...(status.selectedMethod && health
          ? {
              [status.selectedMethod]: {
                ...status.methods[status.selectedMethod],
                ...(login ? { login } : {}),
                health,
              },
            }
          : {}),
      },
      appAvailable: !!this.config,
      installUrl: this.config
        ? `${this.config.webBaseUrl}/apps/${encodeURIComponent(this.config.appSlug)}/installations/new`
        : null,
    };
  }
  async repositories(scope: CloudGithubConnectionScope, page: number) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100)
      throw new HttpError(422, "invalid_input", "Invalid repository page.");
    const access = await this.access(scope);
    const rows = await access.api.http.json(
      `/user/repos?sort=full_name&per_page=100&page=${page}`,
      z.array(githubRepositorySchema).max(100),
    );
    return {
      generation: access.generation,
      repositories: rows
        .filter((row) => !row.archived && !row.disabled)
        .map((row) => ({
          id: String(row.id),
          owner: row.owner.login,
          name: row.name,
          defaultBranch: row.default_branch,
          private: row.private,
          canPush:
            row.permissions?.push === true || row.permissions?.admin === true,
        })),
      nextPage: rows.length === 100 && page < 100 ? page + 1 : null,
      complete: rows.length < 100,
    };
  }
  private scope(
    input: Pick<RepositoryRequest, "organizationId" | "userId">,
  ): CloudGithubConnectionScope {
    if (!input.organizationId)
      throw new HttpError(
        403,
        "github_cloud_access_denied",
        "Choose an organization for cloud GitHub.",
      );
    return { organizationId: input.organizationId, userId: input.userId };
  }
  fingerprintFor(
    input: Pick<RepositoryRequest, "organizationId" | "userId">,
  ): Promise<string> {
    return this.store.fingerprint(this.scope(input));
  }
  async authorizeRepositoryConfiguration(
    organizationId: string,
    userId: string,
    repository: string,
  ): Promise<{ repositoryId: string; assertCurrent(tx: Tx): Promise<void> }> {
    const scope = { organizationId, userId },
      until = Date.now() + 30_000;
    const [owner, name, extra] = repository.split("/");
    if (!owner || !name || extra !== undefined)
      throw new HttpError(
        422,
        "github_repository_invalid",
        "Choose a GitHub repository.",
      );
    const access = await this.access(scope);
    const identity = await access.api.repository(
      await this.repositoryTarget(scope, repository),
    );
    await access.api.http.json(
      `/repositories/${identity.repositoryId}/branches?per_page=1`,
      z.array(z.unknown()).max(1),
    );
    await access.assertCurrent();
    return {
      repositoryId: identity.repositoryId,
      assertCurrent: async (tx) => {
        await this.store.lockCurrent(tx, scope, access.generation);
        if (Date.now() >= until)
          throw new HttpError(
            409,
            "github_verification_expired",
            "Repository access needs to be checked again. Retry saving.",
          );
      },
    };
  }
  async check(input: RepositoryRequest): Promise<string> {
    return (await this.verify(input)).fingerprint;
  }
  async verify(input: RepositoryRequest): Promise<{ fingerprint: string; repositories: CloudGithubRepositoryIdentity[] }> {
    const scope = this.scope(input);
    if (
      !githubName.safeParse(input.owner).success ||
      !input.repositories.length ||
      input.repositories.length > 10 ||
      input.repositories.some((name) => !githubName.safeParse(name).success) ||
      (input.repositoryIds &&
        (input.repositoryIds.length !== input.repositories.length ||
          input.repositoryIds.some((id) => !/^[1-9][0-9]{0,15}$/.test(id))))
    )
      throw new HttpError(
        403,
        "github_repository_invalid",
        "Repository access could not be verified.",
      );
    const access = await this.access(scope);
    const repositories: CloudGithubRepositoryIdentity[] = [];
    for (const [index, name] of input.repositories.entries()) {
      const target = await this.repositoryTarget(
        scope,
        `${input.owner}/${name}`,
      );
      const repository = await access.api.repository({
        ...target,
        ...(input.repositoryIds
          ? { repositoryId: input.repositoryIds[index]! }
          : {}),
      });
      if (input.access === "write" && !repository.canPush)
        throw new HttpError(
          403,
          "github_cloud_write_denied",
          "Your selected GitHub connection needs write access to this repository.",
        );
      // Repository metadata alone does not prove a fine-grained PAT can read
      // source. The branches endpoint requires Contents read, including for an
      // empty repository, without fetching source into the control plane.
      await access.api.http.json(
        `/repositories/${repository.repositoryId}/branches?per_page=1`,
        z.array(z.unknown()).max(1),
      );
      repositories.push(repository);
    }
    await access.assertCurrent();
    return { fingerprint: access.generation, repositories };
  }
}
