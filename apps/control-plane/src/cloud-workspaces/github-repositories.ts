const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 128 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const DIGITS_PATTERN = /^[1-9][0-9]{0,39}$/;

type FetchLike = typeof fetch;

export type CloudWorkspaceRepositoryIdentity = {
  forge: "github.com";
  forgeRepositoryId: string;
  owner: string;
  name: string;
  cloneUrl: string;
  webUrl: string;
  defaultBranch: string;
  visibility: "private" | "internal" | "public";
};

export interface CloudWorkspaceRepositoryResolver {
  resolve(input: {
    installationId: number;
    owner: string;
    repository: string;
  }): Promise<CloudWorkspaceRepositoryIdentity>;
}

type RepositoryCredential = {
  mint(input: {
    installationId: number;
    owner: string;
    repository: string;
  }): Promise<{ token: string; expiresAtMs: number }>;
  revoke(token: string): Promise<void>;
};

function unavailable(): Error {
  return new Error("cloud workspace GitHub repository identity is unavailable");
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    (declaredLength < 0 || declaredLength > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw unavailable();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw unavailable();
  }
}

function exactGithubUrl(
  raw: unknown,
  owner: string,
  repository: string,
  suffix: "" | ".git",
): string {
  if (typeof raw !== "string" || raw.length > 2_048) throw unavailable();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw unavailable();
  }
  const expectedPath = `/${owner}/${repository}${suffix}`.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.toLowerCase() !== expectedPath
  ) {
    throw unavailable();
  }
  return parsed.toString();
}

function repositoryId(value: unknown): string {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  if (!DIGITS_PATTERN.test(normalized)) throw unavailable();
  return normalized;
}

function requiredName(value: unknown): string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw unavailable();
  }
  return value;
}

function requiredGitBranch(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
    }) ||
    !value.split("/").every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    )
  ) {
    throw unavailable();
  }
  return value;
}

function visibility(
  value: unknown,
  isPrivate: unknown,
): CloudWorkspaceRepositoryIdentity["visibility"] {
  if (value === "private" || value === "internal" || value === "public") {
    return value;
  }
  if (isPrivate === true) return "private";
  if (isPrivate === false) return "public";
  throw unavailable();
}

export class GithubCloudWorkspaceRepositoryResolver
  implements CloudWorkspaceRepositoryResolver
{
  private readonly fetch: FetchLike;

  constructor(input: {
    credential: RepositoryCredential;
    fetch?: FetchLike;
  }) {
    this.credential = input.credential;
    this.fetch = input.fetch ?? globalThis.fetch;
  }

  private readonly credential: RepositoryCredential;

  async resolve(input: {
    installationId: number;
    owner: string;
    repository: string;
  }): Promise<CloudWorkspaceRepositoryIdentity> {
    if (
      !Number.isSafeInteger(input.installationId) ||
      input.installationId < 1 ||
      !NAME_PATTERN.test(input.owner) ||
      !NAME_PATTERN.test(input.repository)
    ) {
      throw unavailable();
    }

    const minted = await this.credential.mint(input).catch(() => {
      throw unavailable();
    });
    let resolved: CloudWorkspaceRepositoryIdentity | null = null;
    let resolutionFailed = false;
    try {
      const response = await this.fetch(
        `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`,
        {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${minted.token}`,
            "user-agent": "zeros-control-plane",
            "x-github-api-version": GITHUB_API_VERSION,
          },
        },
      );
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw unavailable();
      }
      const raw = await boundedJson(response);
      const body =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : null;
      if (!body || body.archived === true || body.disabled === true) {
        throw unavailable();
      }
      const ownerBody =
        body.owner && typeof body.owner === "object" && !Array.isArray(body.owner)
          ? (body.owner as Record<string, unknown>)
          : null;
      const owner = requiredName(ownerBody?.login);
      const name = requiredName(body.name);
      if (
        owner.toLowerCase() !== input.owner.toLowerCase() ||
        name.toLowerCase() !== input.repository.toLowerCase() ||
        body.full_name !== `${owner}/${name}`
      ) {
        throw unavailable();
      }
      const defaultBranch = requiredGitBranch(body.default_branch);
      resolved = {
        forge: "github.com",
        forgeRepositoryId: repositoryId(body.id),
        owner,
        name,
        cloneUrl: exactGithubUrl(body.clone_url, owner, name, ".git"),
        webUrl: exactGithubUrl(body.html_url, owner, name, ""),
        defaultBranch,
        visibility: visibility(body.visibility, body.private),
      };
    } catch {
      resolutionFailed = true;
    }

    try {
      await this.credential.revoke(minted.token);
    } catch {
      throw unavailable();
    }
    if (resolutionFailed || !resolved) throw unavailable();
    return resolved;
  }
}
