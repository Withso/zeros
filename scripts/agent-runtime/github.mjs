import { LIMITS, REPOSITORY } from "./config.mjs";
import { invariant, parseJson } from "./contracts.mjs";
import { readBounded } from "./network.mjs";

const MERGE_STATE = `query RuntimeMergeState($number: Int!) { repository(owner: "Withso", name: "zeros") { pullRequest(number: $number) { mergeQueueEntry { id } autoMergeRequest { enabledAt } } } }`;

export class GitHub {
  constructor({
    token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    repository = REPOSITORY,
    fetchImpl = fetch,
  } = {}) {
    invariant(
      repository.toLowerCase() === REPOSITORY.toLowerCase(),
      "Runtime automation is restricted to this repository.",
    );
    this.repository = REPOSITORY;
    this.token = token;
    this.fetch = fetchImpl;
    this.prefix = `/repos/${REPOSITORY}`;
  }

  async request(
    method,
    path,
    body,
    { maximum = LIMITS.patch, raw = false } = {},
  ) {
    invariant(
      (path.startsWith(`${this.prefix}/`) && !/[\r\n#]/.test(path)) ||
        (path === "/graphql" &&
          method === "POST" &&
          body?.query === MERGE_STATE &&
          Number.isSafeInteger(body.variables?.number) &&
          body.variables.number > 0),
      "GitHub request is outside the repository.",
    );
    const url = new URL(`https://api.github.com${path}`);
    invariant(
      path === "/graphql" ||
        (url.pathname.startsWith(`${this.prefix}/`) &&
          !decodeURIComponent(path.split("?")[0])
            .split("/")
            .some((segment) => segment === "." || segment === "..")),
      "GitHub request contains a path escape.",
    );
    invariant(
      ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method),
      "Invalid GitHub request method.",
    );
    const response = await this.fetch(url.href, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(LIMITS.timeout),
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "zeros-runtime-notifications",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(
        `GitHub ${method} failed (HTTP ${response.status}).`,
      );
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const text = (await readBounded(response, maximum)).toString("utf8");
    return raw ? text : parseJson(text, maximum);
  }

  async pages(path, { maximumPages = LIMITS.pages } = {}) {
    const rows = [];
    for (let page = 1; page <= maximumPages; page++) {
      const data = await this.request(
        "GET",
        `${this.prefix}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      invariant(Array.isArray(data), "GitHub pagination changed shape.");
      rows.push(...data);
      if (data.length < 100) return rows;
    }
    throw new Error(
      "GitHub pagination incomplete; refusing a partial snapshot.",
    );
  }

  get(path) {
    return this.request("GET", `${this.prefix}${path}`);
  }
  post(path, body) {
    return this.request("POST", `${this.prefix}${path}`, body);
  }
  patch(path, body) {
    return this.request("PATCH", `${this.prefix}${path}`, body);
  }
  delete(path) {
    return this.request("DELETE", `${this.prefix}${path}`);
  }

  async mergeState(number) {
    const result = await this.request("POST", "/graphql", {
      query: MERGE_STATE,
      variables: { number },
    });
    const pr = result.data?.repository?.pullRequest;
    invariant(
      !result.errors &&
        pr &&
        Object.hasOwn(pr, "mergeQueueEntry") &&
        Object.hasOwn(pr, "autoMergeRequest"),
      "Unable to verify merge queue state.",
    );
    return {
      mergeQueueEntry: pr.mergeQueueEntry,
      auto_merge: pr.autoMergeRequest,
    };
  }

  async file(path, ref) {
    invariant(
      typeof path === "string" &&
        !path.split("/").includes("..") &&
        typeof ref === "string" &&
        /^[a-f0-9]{40}$/.test(ref),
      "Invalid immutable file request.",
    );
    const value = await this.get(
      `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`,
    );
    invariant(
      value.type === "file" &&
        value.encoding === "base64" &&
        value.size <= LIMITS.file,
      "Repository file is not a bounded regular file.",
    );
    return Buffer.from(value.content, "base64").toString("utf8");
  }
}

export function trustedComment(comment, issue, login = "github-actions[bot]") {
  return (
    comment?.user?.type === "Bot" &&
    comment.user.login === login &&
    comment.issue_url?.toLowerCase() ===
      `https://api.github.com/repos/${REPOSITORY}/issues/${issue}`.toLowerCase()
  );
}
