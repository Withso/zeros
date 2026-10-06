import { REPOSITORY } from "./recovery-policy.mjs";
import {
  INCIDENT_SCHEMA,
  parseContractBody,
  validateSchema,
} from "./recovery-contract.mjs";

export const REPO_API = "/repos/" + REPOSITORY;
const SHA = /^[a-f0-9]{40}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const LABELS = new Set([
  "ci-failure",
  "autofix",
  "ci:ui-smoke",
  "ci:macos",
  "ci:control-plane-db",
]);
const exactKeys = (value, keys) =>
  value && Object.keys(value).sort().join(",") === keys.sort().join(",");

export function allowWrite(kind, method, endpoint, body) {
  const path = endpoint.slice(REPO_API.length);
  if (!endpoint.startsWith(REPO_API + "/") || endpoint.includes("?"))
    return false;
  if (kind === "retry")
    return (
      method === "POST" &&
      /^\/actions\/runs\/[1-9]\d{0,19}\/rerun-failed-jobs$/.test(path) &&
      exactKeys(body, [])
    );
  if (kind !== "incident") return false;
  if (method === "DELETE")
    return (
      /^\/issues\/[1-9]\d*\/labels\/autofix$/.test(path) && body === undefined
    );
  if (method !== "POST") return false;
  if (path === "/git/blobs") {
    if (
      !exactKeys(body, ["content", "encoding"]) ||
      body.encoding !== "utf-8" ||
      Buffer.byteLength(body.content) > 4096
    )
      return false;
    try {
      validateSchema(JSON.parse(body.content), INCIDENT_SCHEMA.$defs.marker);
      return true;
    } catch {
      return false;
    }
  }
  if (path === "/git/trees")
    return (
      exactKeys(body, ["base_tree", "tree"]) &&
      SHA.test(body.base_tree) &&
      body.tree.length === 1 &&
      exactKeys(body.tree[0], ["path", "mode", "type", "sha"]) &&
      /^\.github\/ci-incidents\/[a-f0-9]{64}\.json$/.test(body.tree[0].path) &&
      body.tree[0].mode === "100644" &&
      body.tree[0].type === "blob" &&
      SHA.test(body.tree[0].sha)
    );
  if (path === "/git/commits")
    return (
      exactKeys(body, ["message", "tree", "parents", "author", "committer"]) &&
      /^ci: record (composer|quality|vitest|build|macos|control-plane-db|control-plane-static|secret-scan|unknown|full suite) failure on main$/.test(
        body.message,
      ) &&
      SHA.test(body.tree) &&
      body.parents.length === 1 &&
      SHA.test(body.parents[0]) &&
      [body.author, body.committer].every(
        (identity) =>
          exactKeys(identity, ["name", "email"]) &&
          /^[a-z0-9-]+\[bot\]$/i.test(identity.name) &&
          /^[1-9]\d*\+[a-z0-9-]+\[bot\]@users\.noreply\.github\.com$/i.test(
            identity.email,
          ),
      )
    );
  if (path === "/git/refs")
    return (
      exactKeys(body, ["ref", "sha"]) &&
      /^refs\/heads\/ci-fix\/[a-f0-9]{64}$/.test(body.ref) &&
      SHA.test(body.sha)
    );
  if (path === "/pulls") {
    if (
      !exactKeys(body, ["title", "body", "head", "base", "draft"]) ||
      body.base !== "main" ||
      body.draft !== true ||
      !/^ci-fix\/[a-f0-9]{64}$/.test(body.head)
    )
      return false;
    try {
      const contract = parseContractBody(body.body);
      return (
        contract.branch === body.head &&
        /^fix\(ci\): restore (composer|quality|vitest|build|macos|control-plane-db|control-plane-static|secret-scan|unknown|full suite) on main$/.test(
          body.title,
        )
      );
    } catch {
      return false;
    }
  }
  if (/^\/issues\/[1-9]\d*\/comments$/.test(path)) {
    if (!exactKeys(body, ["body"])) return false;
    try {
      parseContractBody(body.body);
      return true;
    } catch {
      return false;
    }
  }
  if (/^\/issues\/[1-9]\d*\/labels$/.test(path))
    return (
      exactKeys(body, ["labels"]) &&
      Array.isArray(body.labels) &&
      body.labels.length <= LABELS.size &&
      body.labels.every((label) => LABELS.has(label))
    );
  return false;
}

export class GitHubApiError extends Error {
  constructor(method, endpoint, status) {
    // Never reflect response bodies, headers, credentials or raw diagnostics.
    super(
      "GitHub " + method + " " + endpoint.split("?")[0] + " returned " + status,
    );
    this.status = status;
  }
}

export function createGitHubApi({
  token,
  fetchImpl = fetch,
  writeKind = "none",
}) {
  async function request(method, endpoint, body, { missing = false } = {}) {
    if (
      !(
        endpoint === REPO_API ||
        endpoint.startsWith(REPO_API + "/") ||
        /^\/(apps|users)\/[A-Za-z0-9%[\]-]+$/.test(endpoint)
      )
    ) {
      throw new Error("GitHub endpoint is outside the recovery repository");
    }
    if (method !== "GET" && !allowWrite(writeKind, method, endpoint, body))
      throw new Error("Recovery write endpoint or payload is not allowed");
    const response = await fetchImpl("https://api.github.com" + endpoint, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (missing && response.status === 404) return null;
    if (!response.ok)
      throw new GitHubApiError(method, endpoint, response.status);
    if (response.status === 204) return null;
    const length = Number(response.headers.get("content-length"));
    if (length > 2 * 1024 * 1024)
      throw new Error("GitHub recovery response exceeds 2 MiB");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("GitHub recovery response exceeds 2 MiB");
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return {
    get: (endpoint, options) => request("GET", endpoint, undefined, options),
    post: (endpoint, body) => request("POST", endpoint, body),
    delete: (endpoint) => request("DELETE", endpoint),
  };
}

export async function paginate(
  api,
  endpoint,
  key = null,
  maxPages = 10,
  perPage = 100,
) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await api.get(
      endpoint +
        (endpoint.includes("?") ? "&" : "?") +
        "per_page=" +
        perPage +
        "&page=" +
        page,
    );
    const batch = key ? result[key] : result;
    if (!Array.isArray(batch))
      throw new Error("Invalid GitHub recovery collection");
    rows.push(...batch);
    if (batch.length < perPage) return rows;
  }
  throw new Error(
    "GitHub recovery pagination bound exceeded; no writes are safe",
  );
}

export function reservationName({ intent, key, payloadHash, runId, attempt }) {
  if (
    !["retry", "create", "upsert", "resolve"].includes(intent) ||
    !(
      SIGNATURE.test(key) ||
      (intent === "retry" && /^[1-9]\d{0,19}$/.test(key))
    ) ||
    !SIGNATURE.test(payloadHash) ||
    !/^[1-9]\d{0,19}$/.test(String(runId)) ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > 100
  )
    throw new Error("Invalid recovery reservation identity");
  return ["ci-recovery", intent, key, payloadHash, runId, attempt].join("-");
}

export function parseReservationName(name) {
  const match =
    /^ci-recovery-(retry|create|upsert|resolve)-([a-f0-9]{64}|[1-9]\d{0,19})-([a-f0-9]{64})-([1-9]\d{0,19})-([1-9]\d{0,2})$/.exec(
      name ?? "",
    );
  if (
    !match ||
    Number(match[5]) > 100 ||
    (match[1] !== "retry" && !SIGNATURE.test(match[2]))
  )
    return null;
  return {
    intent: match[1],
    key: match[2],
    payloadHash: match[3],
    runId: match[4],
    attempt: Number(match[5]),
  };
}
