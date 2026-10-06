import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGitHubApi, REPO_API } from "../../ci/recovery-api.mjs";
import { RecoveryController } from "../../ci/recovery-controller.mjs";

export const jobFixtures = JSON.parse(
  readFileSync(new URL("./ci-recovery-jobs.json", import.meta.url), "utf8"),
);
export const NOW = "2026-10-06T12:00:00.000Z";
export const SOURCE_SHA = "a".repeat(40);
export const MAIN_SHA = "b".repeat(40);
const gitSha = (key) => createHash("sha1").update(key).digest("hex");
export const greenJobs = [
  "quality",
  "test",
  "build",
  "source-sync (macOS)",
  "control plane",
  "ui-smoke (composer)",
  "secret scan (PR commit range)",
  "source-sync workload (macOS)",
  "tests-vitest (1/2)",
  "tests-vitest (2/2)",
  ...[1, 2, 3, 4].map((part) => "control-plane database (" + part + ")"),
].map((name, i) => ({
  id: 201 + i,
  name,
  conclusion: "success",
  steps:
    name === "ui-smoke (composer)"
      ? [
          {
            number: 8,
            name: "Composer model-menu interaction contract",
            conclusion: "success",
          },
        ]
      : [],
}));

export function sourceRun(overrides = {}) {
  return {
    id: 123,
    workflow_id: 321408597,
    name: "Preflight",
    path: ".github/workflows/preflight.yml",
    event: "push",
    head_branch: "main",
    head_sha: SOURCE_SHA,
    repository: { full_name: "Withso/zeros" },
    head_repository: { full_name: "Withso/zeros" },
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    created_at: NOW,
    ...overrides,
  };
}

export function recoveryFixture({
  mode = "enabled",
  jobs = [jobFixtures.composer],
  run = sourceRun(),
} = {}) {
  const bot = { id: 51, login: "zeros-ci-incident[bot]", type: "Bot" };
  const app = { id: 42, slug: "zeros-ci-incident", client_id: "Iv1.fixture" };
  const workflows = {
    preflight: {
      id: 321408597,
      name: "Preflight",
      path: ".github/workflows/preflight.yml",
    },
    controller: {
      id: 456,
      name: "CI Recovery",
      path: ".github/workflows/ci-recovery.yml",
    },
  };
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "Withso/zeros",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: MAIN_SHA,
    GITHUB_RUN_ID: "900",
    GITHUB_RUN_ATTEMPT: "1",
    ZEROS_CI_RECOVERY: mode,
    ZEROS_CI_INCIDENT_APP_CLIENT_ID: app.client_id,
    ZEROS_CI_INCIDENT_APP_SLUG: app.slug,
    INCIDENT_APP_SLUG: app.slug,
  };
  const state = {
    env,
    main: MAIN_SHA,
    workflows,
    bot,
    app,
    requests: [],
    writes: [],
    pulls: [],
    runs: new Map([[String(run.id), structuredClone(run)]]),
    jobs: new Map([[String(run.id), structuredClone(jobs)]]),
    artifacts: [],
    comments: new Map(),
    refs: new Map(),
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
    associatedPrs: [],
    divergent: new Set(),
    rerunError: false,
    failLabelDelete: false,
    beforeGetRun: null,
  };
  function observer(id, attempt = 1, overrides = {}) {
    return {
      ...sourceRun(),
      id: Number(id),
      workflow_id: workflows.controller.id,
      name: workflows.controller.name,
      path: workflows.controller.path,
      event: "workflow_run",
      head_sha: MAIN_SHA,
      run_attempt: attempt,
      status: "in_progress",
      conclusion: null,
      ...overrides,
    };
  }
  state.runs.set(env.GITHUB_RUN_ID, observer(env.GITHUB_RUN_ID));
  const response = (json, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  const cloneResponse = (json) => response(structuredClone(json));
  async function fetchImpl(url, options) {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    const method = options.method;
    const body = options.body ? JSON.parse(options.body) : undefined;
    const request = {
      method,
      path,
      query: parsed.search,
      body,
      authorization: options.headers.Authorization,
    };
    state.requests.push(request);
    if (method !== "GET") state.writes.push(request);
    const rel = path.startsWith(REPO_API) ? path.slice(REPO_API.length) : path;
    if (method === "GET") {
      if (path === REPO_API)
        return cloneResponse({
          id: 7,
          full_name: "Withso/zeros",
          default_branch: "main",
        });
      if (rel === "/actions/workflows/preflight.yml")
        return cloneResponse(workflows.preflight);
      if (rel === "/actions/workflows/ci-recovery.yml")
        return cloneResponse(workflows.controller);
      if (rel === "/git/ref/heads/main")
        return cloneResponse({ object: { type: "commit", sha: state.main } });
      let match;
      if ((match = /^\/git\/ref\/heads\/(.+)$/.exec(rel))) {
        return state.refs.has(match[1])
          ? cloneResponse({
              object: { type: "commit", sha: state.refs.get(match[1]) },
            })
          : response({}, 404);
      }
      if ((match = /^\/actions\/workflows\/\d+\/runs$/.exec(rel))) {
        return cloneResponse({
          workflow_runs: [...state.runs.values()].filter(
            (r) => r.workflow_id === workflows.preflight.id,
          ),
        });
      }
      if ((match = /^\/actions\/runs\/(\d+)$/.exec(rel))) {
        if (state.beforeGetRun) state.beforeGetRun(match[1]);
        return state.runs.has(match[1])
          ? cloneResponse(state.runs.get(match[1]))
          : response({}, 404);
      }
      if (
        (match = /^\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/jobs$/.exec(rel))
      ) {
        const r = state.runs.get(match[1]);
        return cloneResponse({
          jobs:
            r?.workflow_id === workflows.controller.id
              ? [
                  {
                    id: 9000,
                    name: "writer",
                    steps: [
                      {
                        name: "Save recovery reservation",
                        conclusion: "success",
                      },
                    ],
                  },
                ]
              : (state.jobs.get(match[1]) ?? []),
        });
      }
      if (rel === "/actions/artifacts")
        return cloneResponse({ artifacts: state.artifacts });
      if ((match = /^\/actions\/artifacts\/(\d+)$/.exec(rel))) {
        const artifact = state.artifacts.find((a) => String(a.id) === match[1]);
        return artifact ? cloneResponse(artifact) : response({}, 404);
      }
      if (rel === "/pulls") {
        const head = parsed.searchParams.get("head")?.replace(/^Withso:/, "");
        const status = parsed.searchParams.get("state");
        return cloneResponse(
          state.pulls.filter(
            (pr) =>
              (!head || pr.head.ref === head) &&
              (!status || status === "all" || pr.state === status),
          ),
        );
      }
      if ((match = /^\/pulls\/(\d+)$/.exec(rel))) {
        const pr = state.pulls.find((pr) => pr.number === Number(match[1]));
        return pr ? cloneResponse(pr) : response({}, 404);
      }
      if ((match = /^\/issues\/(\d+)$/.exec(rel))) {
        const pr = state.pulls.find((pr) => pr.number === Number(match[1]));
        return pr
          ? cloneResponse({
              user: pr.user,
              performed_via_github_app: Object.hasOwn(pr, "app") ? pr.app : app,
            })
          : response({}, 404);
      }
      if ((match = /^\/issues\/(\d+)\/comments$/.exec(rel)))
        return cloneResponse(state.comments.get(Number(match[1])) ?? []);
      if (
        (match = /^\/compare\/([a-f0-9]{40})\.{3}([a-f0-9]{40})$/.exec(rel))
      ) {
        const divergent = state.divergent.has(match[1]);
        return cloneResponse({
          base_commit: { sha: match[1] },
          merge_base_commit: { sha: divergent ? "f".repeat(40) : match[1] },
          status: divergent
            ? "diverged"
            : match[1] === match[2]
              ? "identical"
              : "ahead",
        });
      }
      if (/^\/commits\/[a-f0-9]{40}\/pulls$/.test(rel))
        return cloneResponse(state.associatedPrs);
      if ((match = /^\/git\/commits\/([a-f0-9]{40})$/.exec(rel)))
        return cloneResponse({
          sha: match[1],
          tree: { sha: gitSha("main-tree") },
        });
      if ((match = /^\/commits\/([a-f0-9]{40})$/.exec(rel)))
        return state.commits.has(match[1])
          ? cloneResponse(state.commits.get(match[1]))
          : response({}, 404);
      if ((match = /^\/contents\/(.+)$/.exec(rel))) {
        const commit = state.commits.get(parsed.searchParams.get("ref"));
        const file = commit?.files?.find((f) => f.filename === match[1]);
        const content = file ? state.blobs.get(file.sha) : null;
        return content
          ? cloneResponse({
              type: "file",
              encoding: "base64",
              size: Buffer.byteLength(content),
              content: Buffer.from(content).toString("base64"),
            })
          : response({}, 404);
      }
      if (path === "/users/" + bot.login) return cloneResponse(bot);
      if (path === "/apps/" + app.slug) return cloneResponse(app);
      return response({ message: "Unknown fixture GET" }, 404);
    }
    if (method === "POST") {
      if (/^\/actions\/runs\/\d+\/rerun-failed-jobs$/.test(rel)) {
        if (state.rerunError)
          return response({ message: "sensitive response never emitted" }, 502);
        const run = state.runs.get(rel.split("/")[3]);
        run.run_attempt++;
        run.status = "queued";
        run.conclusion = null;
        return response(null, 201);
      }
      if (rel === "/git/blobs") {
        const sha = gitSha(body.content);
        state.blobs.set(sha, body.content);
        return response({ sha }, 201);
      }
      if (rel === "/git/trees") {
        const sha = gitSha(JSON.stringify(body));
        state.trees.set(sha, body);
        return response({ sha }, 201);
      }
      if (rel === "/git/commits") {
        const sha = gitSha(JSON.stringify(body));
        const tree = state.trees.get(body.tree);
        state.commits.set(sha, {
          sha,
          author: bot,
          parents: body.parents.map((parent) => ({ sha: parent })),
          files: tree.tree.map((file) => ({
            filename: file.path,
            status: "added",
            sha: file.sha,
          })),
        });
        return response({ sha }, 201);
      }
      if (rel === "/git/refs") {
        const branch = body.ref.replace(/^refs\/heads\//, "");
        if (state.refs.has(branch)) return response({}, 422);
        state.refs.set(branch, body.sha);
        return response({ ref: body.ref, object: { sha: body.sha } }, 201);
      }
      if (rel === "/pulls") {
        const pr = {
          number: 200 + state.pulls.length,
          body: body.body,
          title: body.title,
          state: "open",
          draft: true,
          commits: 1,
          assignees: [],
          labels: [],
          created_at: NOW,
          user: bot,
          app,
          base: { ref: body.base, repo: { full_name: "Withso/zeros" } },
          head: {
            ref: body.head,
            sha: state.refs.get(body.head),
            repo: { full_name: "Withso/zeros" },
          },
        };
        state.pulls.push(pr);
        return cloneResponse(pr);
      }
      let match;
      if ((match = /^\/issues\/(\d+)\/labels$/.exec(rel))) {
        const pr = state.pulls.find((p) => p.number === Number(match[1]));
        pr.labels = [
          ...new Set([...pr.labels.map((l) => l.name), ...body.labels]),
        ].map((name) => ({ name }));
        return cloneResponse(pr.labels);
      }
      if ((match = /^\/issues\/(\d+)\/comments$/.exec(rel))) {
        const comments = state.comments.get(Number(match[1])) ?? [];
        comments.push({ id: comments.length + 1, body: body.body, user: bot });
        state.comments.set(Number(match[1]), comments);
        return cloneResponse(comments.at(-1));
      }
    }
    if (method === "DELETE" && /^\/issues\/\d+\/labels\/autofix$/.test(rel)) {
      if (state.failLabelDelete) return response({}, 502);
      const pr = state.pulls.find(
        (p) => p.number === Number(rel.split("/")[2]),
      );
      pr.labels = pr.labels.filter((label) => label.name !== "autofix");
      return cloneResponse(pr.labels);
    }
    return response({}, 404);
  }
  const readApi = createGitHubApi({ token: "fixture-read-token", fetchImpl });
  const controller = (writeKind = "incident") =>
    new RecoveryController({
      readApi,
      writeApi: createGitHubApi({
        token:
          writeKind === "retry" ? "fixture-read-token" : "fixture-app-token",
        fetchImpl,
        writeKind,
      }),
      env: state.env,
      now: NOW,
    });
  function save(reservation) {
    const artifact = {
      id: 1000 + state.artifacts.length,
      name: reservation.artifact_name,
      digest:
        "sha256:" +
        createHash("sha256").update(JSON.stringify(reservation)).digest("hex"),
      expired: false,
      created_at: NOW,
      size_in_bytes: 2048,
      workflow_run: {
        id: Number(env.GITHUB_RUN_ID),
        head_branch: "main",
        head_sha: env.GITHUB_SHA,
      },
    };
    state.artifacts.unshift(artifact);
    // upload-artifact's output is the raw hex hash; REST prefixes it.
    return {
      artifactId: String(artifact.id),
      artifactDigest: artifact.digest.slice("sha256:".length),
    };
  }
  function nextController() {
    env.GITHUB_RUN_ID = String(Number(env.GITHUB_RUN_ID) + 1);
    state.runs.set(env.GITHUB_RUN_ID, observer(env.GITHUB_RUN_ID));
  }
  return { state, readApi, controller, save, nextController, fetchImpl };
}
