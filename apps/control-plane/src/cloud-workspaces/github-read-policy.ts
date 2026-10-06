import { z } from "zod";

// Pinned to the engine queries by github-read-policy.test.ts. No arbitrary
// GraphQL, node IDs, aliases, pagination sizes or additional selections.
const threadsQuery = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid baseRefOid
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path diffSide startLine line originalStartLine originalLine
          isResolved isOutdated viewerCanResolve viewerCanUnresolve
          comments(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id databaseId body url createdAt updatedAt diffHunk
              author { login avatarUrl __typename }
              originalCommit { oid }
            }
          }
        }
      }
    }
  }
}`;
const commitStatsQuery = `query ($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              commits(first: 100) {
                nodes {
                  commit {
                    oid
                    additions
                    deletions
                    changedFilesIfAvailable
                    authors(first: 6) {
                      nodes { name user { login avatarUrl } }
                    }
                  }
                }
              }
            }
          }
        }`;

export const githubReadRequestSchema = z.object({
  method: z.enum(["GET", "POST"]),
  path: z.string().min(1).max(4096),
  format: z.enum(["json", "diff"]).default("json"),
  fresh: z.boolean().optional(),
  body: z.object({ query: z.string().max(8192), variables: z.record(z.unknown()) }).strict().optional(),
}).strict();
export type GithubReadRequest = z.infer<typeof githubReadRequestSchema>;
const denied = () => new Error("GitHub read request is not authorized");
const compact = (query: string) => query.replace(/\s/g, "");
const ref = /^[A-Za-z0-9_./:~+-]{1,512}$/;

export function authorizeGithubRead(repository: { owner: string; repository: string }, value: unknown): GithubReadRequest {
  const request = githubReadRequestSchema.parse(value);
  if (request.method === "POST") {
    if (request.path !== "/graphql" || request.format !== "json" || !request.body) throw denied();
    const query = compact(request.body.query);
    const threads = query === compact(threadsQuery);
    if (!threads && query !== compact(commitStatsQuery)) throw denied();
    const variables = z.object({ owner: z.literal(repository.owner), repo: z.literal(repository.repository), number: z.number().int().positive().max(2_147_483_647),
      ...(threads ? { after: z.string().max(1024).nullable().optional() } : {}),
    }).strict().parse(request.body.variables);
    return { ...request, body: { query: threads ? threadsQuery : commitStatsQuery, variables } };
  }
  if (request.body || !request.path.startsWith("/") || request.path.includes("#") || /[\\\s]/.test(request.path)) throw denied();
  const url = new URL(request.path, "https://api.github.com");
  if (url.origin !== "https://api.github.com" || url.pathname !== request.path.split("?")[0]) throw denied();
  const prefix = `/repos/${repository.owner}/${repository.repository}`;
  if (url.pathname.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) throw denied();
  const suffix = decodeURIComponent(url.pathname.slice(prefix.length));
  if (suffix.split("/").some(part => part === "." || part === "..")) throw denied();
  const paging = ["per_page", "page"];
  let keys: string[];
  if (suffix === "") keys = [];
  else if (suffix === "/branches") keys = paging;
  else if (suffix === "/pulls") keys = [...paging, "state", "head", "base", "sort", "direction"];
  else if (/^\/pulls\/[1-9][0-9]{0,9}$/.test(suffix)) keys = [];
  else if (/^\/pulls\/[1-9][0-9]{0,9}\/(commits|reviews|comments)$/.test(suffix) || /^\/issues\/[1-9][0-9]{0,9}\/(comments|timeline)$/.test(suffix) || /^\/check-runs\/[1-9][0-9]{0,15}\/annotations$/.test(suffix)) keys = paging;
  else if (/^\/commits\/[A-Za-z0-9_./:~+-]{1,512}\/(check-runs|statuses|status)$/.test(suffix)) keys = suffix.endsWith("/check-runs") ? [...paging, "filter"] : paging;
  else if (suffix.startsWith("/compare/") && ref.test(suffix.slice(9)) && suffix.slice(9).includes("...")) keys = paging;
  else throw denied();
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!keys.includes(key) || seen.has(key)) throw denied();
    seen.add(key);
    if (key === "per_page" || key === "page") {
      if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > (key === "page" ? 10 : 100)) throw denied();
    } else if (key === "state" ? !["open", "closed", "all"].includes(value)
      : key === "sort" ? !["created", "updated", "popularity", "long-running"].includes(value)
      : key === "direction" ? !["asc", "desc"].includes(value)
      : key === "filter" ? !["latest", "all"].includes(value) : !ref.test(value)) throw denied();
  }
  if (request.format === "diff" && !/^\/pulls\/[1-9][0-9]{0,9}$/.test(suffix)) throw denied();
  url.searchParams.sort();
  return { ...request, path: `${prefix}${url.pathname.slice(prefix.length)}${url.search}` };
}
