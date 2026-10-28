import { z } from "zod";
import { HttpError } from "../authz.js";
import { GithubTemporaryError, githubRateLimit, githubRetryAfter } from "../github-availability.js";

export type CloudGithubHttpOptions = {
  apiBaseUrl: string;
  /** User access token or PAT. Never an installation token for user actions. */
  token: string;
  assertCurrent(): Promise<void>;
  fetch?: typeof fetch;
};
const unavailable = () =>
  new HttpError(
    503,
    "github_unavailable",
    "GitHub could not be reached. Try again.",
  );

/** Only fixed GitHub API paths reach this courier. No upstream response body,
 * arbitrary URL, redirect, or credential is included in an error. */
export class CloudGithubHttp {
  constructor(private readonly options: CloudGithubHttpOptions) {}

  async request(
    path: string,
    input: {
      method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      body?: unknown;
      text?: boolean;
      mutation?: boolean;
      repositoryLookup?: boolean;
    } = {},
  ): Promise<unknown> {
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      /[\0\r\n\\]/.test(path)
    )
      throw new HttpError(422, "invalid_input", "Invalid GitHub request.");
    const mutation =
      input.mutation ??
      (path !== "/graphql" &&
        input.method !== undefined &&
        input.method !== "GET");
    let response!: Response;
    let url = `${this.options.apiBaseUrl.replace(/\/$/, "")}${path}`;
    for (let redirects = 0; ; redirects++) {
      await this.options.assertCurrent();
      try {
        response = await (this.options.fetch ?? fetch)(url, {
          method: input.method ?? "GET",
          redirect: input.repositoryLookup ? "manual" : "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            authorization: `Bearer ${this.options.token}`,
            accept: input.text
              ? "application/vnd.github.diff"
              : "application/vnd.github+json",
            "x-github-api-version": "2026-03-10",
            "user-agent": "zeros-control-plane",
            ...(input.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
        });
      } catch {
        throw unavailable();
      }
      if (
        !input.repositoryLookup ||
        ![301, 302, 307, 308].includes(response.status)
      )
        break;
      try {
        await response.body?.cancel();
        const next = new URL(response.headers.get("location") ?? "", url);
        if (
          redirects >= 2 ||
          (input.method && input.method !== "GET") ||
          next.origin !== new URL(this.options.apiBaseUrl).origin ||
          next.username ||
          next.password ||
          next.search ||
          next.hash ||
          !/^\/(repositories\/[1-9][0-9]*|repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.test(
            next.pathname,
          )
        )
          throw unavailable();
        url = next.toString();
      } catch {
        throw unavailable();
      }
    }
    if (!response.ok) {
      const limited = await githubRateLimit(response);
      void response.body?.cancel().catch(() => {});
      if (limited) throw limited;
      if (response.status === 401)
        throw new HttpError(
          409,
          "github_authorization_expired",
          "Reconnect your GitHub connection to continue.",
        );
      if (
        response.status === 403 &&
        response.headers.get("x-github-sso")?.includes("required")
      )
        throw new HttpError(
          403,
          "github_sso_required",
          "Authorize this connection for your organization in GitHub.",
        );
      if (response.status === 403)
        throw new HttpError(
          403,
          "github_cloud_access_denied",
          "Your selected GitHub connection does not permit this action.",
        );
      if (response.status === 404)
        throw new HttpError(
          404,
          "github_repository_unavailable",
          "This repository or pull request is unavailable to your selected GitHub connection.",
        );
      if (response.status === 405)
        throw new HttpError(
          409,
          "github_merge_blocked",
          "GitHub requires checks, reviews, or branch protection conditions before merging.",
        );
      if (response.status === 409)
        throw new HttpError(
          409,
          "github_pr_changed",
          "The pull request changed. Refresh before trying again.",
        );
      if (response.status === 422)
        throw new HttpError(
          422,
          "github_invalid_operation",
          "GitHub could not apply this action. Refresh the pull request and check its current state.",
        );
      throw new GithubTemporaryError("github_unavailable", githubRetryAfter(response));
    }
    if (response.status === 204) {
      if (!mutation) await this.options.assertCurrent();
      return null;
    }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    let text = "",
      bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new HttpError(
            413,
            "github_response_too_large",
            "This GitHub response is too large. Open it in GitHub.",
          );
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unavailable();
    } finally {
      reader.releaseLock();
    }
    // A confirmed write is an outcome, even if access was revoked while it was
    // in flight. Its caller fences presentation and returns that receipt without
    // replaying it. Protected reads always revalidate before releasing data.
    if (!mutation) await this.options.assertCurrent();
    if (input.text) return text;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unavailable();
    }
  }

  async json<T>(
    path: string,
    schema: z.ZodType<T>,
    input?: Parameters<CloudGithubHttp["request"]>[1],
  ): Promise<T> {
    const parsed = schema.safeParse(await this.request(path, input));
    if (!parsed.success)
      throw new HttpError(
        503,
        "github_invalid_response",
        "GitHub returned an incomplete response. Try again.",
      );
    return parsed.data;
  }

  async pages<T>(path: string, schema: z.ZodType<T>, limit = 10): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= limit; page++) {
      const values = await this.json(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        z.array(schema).max(100),
      );
      rows.push(...values);
      if (values.length < 100) return rows;
    }
    throw new HttpError(
      413,
      "github_results_truncated",
      "GitHub returned too many results. Open the full list in GitHub.",
    );
  }
}

export const githubName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => value !== "." && value !== "..");
export const githubSha = z.string().regex(/^[a-f0-9]{40}$/);
export const githubId = z.number().int().positive().safe();
export const githubDate = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
export const githubRepositorySchema = z.object({
  id: githubId,
  name: githubName,
  owner: z.object({ login: githubName }),
  default_branch: z.string().min(1).max(512),
  private: z.boolean(),
  archived: z.boolean(),
  disabled: z.boolean().optional(),
  permissions: z
    .object({
      pull: z.boolean().optional(),
      push: z.boolean().optional(),
      admin: z.boolean().optional(),
    })
    .optional(),
});
export type CloudGithubRepositoryIdentity = {
  repositoryId: string;
  repository: string;
  defaultBranch: string;
  private: boolean;
  canPush: boolean;
};
export type CloudGithubRepositoryTarget = {
  repositoryId?: string | null;
  repository: string;
};

export async function resolveCloudGithubRepository(
  http: CloudGithubHttp,
  target: CloudGithubRepositoryTarget,
): Promise<CloudGithubRepositoryIdentity> {
  const id = target.repositoryId;
  if (id != null && !/^[1-9][0-9]{0,15}$/.test(id))
    throw new HttpError(
      409,
      "github_repository_changed",
      "The saved GitHub repository identity is invalid.",
    );
  const parts = target.repository.split("/");
  if (
    parts.length !== 2 ||
    parts.some((value) => !githubName.safeParse(value).success)
  )
    throw new HttpError(
      422,
      "github_repository_invalid",
      "Select a GitHub repository.",
    );
  const row = await http.json(
    id
      ? `/repositories/${id}`
      : `/repos/${parts.map(encodeURIComponent).join("/")}`,
    githubRepositorySchema,
    { repositoryLookup: true },
  );
  if (id && String(row.id) !== id)
    throw new HttpError(
      409,
      "github_repository_changed",
      "The GitHub repository identity changed. Reconnect before continuing.",
    );
  if (row.archived || row.disabled)
    throw new HttpError(
      403,
      "github_repository_unavailable",
      "This repository is archived or disabled in GitHub.",
    );
  return {
    repositoryId: String(row.id),
    repository: `${row.owner.login}/${row.name}`,
    defaultBranch: row.default_branch,
    private: row.private,
    canPush: row.permissions?.push === true || row.permissions?.admin === true,
  };
}
