#!/usr/bin/env node
// Merge with the workspace's own gh identity and the checked PR head.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "Withso/zeros";
const OWNER_REVIEW =
  "This PR changes CI definitions; the owner must review and merge it.";
const USAGE =
  "usage: pnpm agent:merge <pr-number> [--immediate] [--dry-run] [--force --reason <human-PR-comment-URL>]";
const SKIP_MARKER =
  /\[(?:skip\s+ci|ci\s+skip|no\s+ci|skip\s+actions|actions\s+skip)\]|skip-checks:\s*true\b/i;
const CHECK_BUCKETS = new Set([
  "pass",
  "fail",
  "pending",
  "skipping",
  "cancel",
]);
const FAILED_STATES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "CANCELLED",
  "STARTUP_FAILURE",
  "STALE",
]);
const CI_DEFINITION_URL = new URL("./ci/ci-definition.mjs", import.meta.url);
const OPEN_PULL_REQUESTS_QUERY = `query($endCursor: String) {
  repository(owner: "Withso", name: "zeros") {
    pullRequests(states: OPEN, first: 100, after: $endCursor) {
      nodes { number autoMergeRequest { enabledAt } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const IMMEDIATE_PR_QUERY = `query ImmediateMergePreflight($number: Int!) {
  repository(owner: "Withso", name: "zeros") {
    pullRequest(number: $number) {
      id number title body state isDraft isCrossRepository changedFiles
      headRefOid baseRefOid baseRefName mergeable mergeStateStatus reviewDecision
      isInMergeQueue viewerCanMergeAsAdmin autoMergeRequest { enabledAt }
      labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
    }
  }
}`;
const IMMEDIATE_QUEUE_QUERY = `query ImmediateMergeQueue($branch: String!) {
  repository(owner: "Withso", name: "zeros") { mergeQueue(branch: $branch) { id } }
}`;
const MERGED_FIELDS = `id number state merged headRefOid baseRefName
  mergeCommit { oid } autoMergeRequest { enabledAt } isInMergeQueue`;
const IMMEDIATE_MUTATION = `mutation ImmediateMerge($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) { pullRequest { ${MERGED_FIELDS} } }
}`;
const IMMEDIATE_RESULT_QUERY = `query ImmediateMergeResult($number: Int!) {
  repository(owner: "Withso", name: "zeros") {
    pullRequest(number: $number) { ${MERGED_FIELDS} }
  }
}`;

const refuse = (code, message) => ({ allowed: false, code, message });
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const human = (user) =>
  user?.type === "User" &&
  typeof user.login === "string" &&
  /^[a-z\d][a-z\d-]{0,38}$/i.test(user.login);
const validAutoMerge = (value) =>
  value === null ||
  (typeof value?.enabledAt === "string" &&
    Number.isFinite(Date.parse(value.enabledAt)));

function commentId(reason, number) {
  if (typeof reason !== "string") return null;
  const match =
    /^https:\/\/github\.com\/Withso\/zeros\/pull\/(\d+)#issuecomment-(\d+)$/i.exec(
      reason,
    );
  return match &&
    Number(match[1]) === number &&
    positiveInteger(Number(match[2]))
    ? match[2]
    : null;
}

/** Pure policy over gh JSON snapshots. No credentials, processes or writes. */
export function decideMerge(
  snapshot,
  {
    isCiDefinitionPath = null,
    force = false,
    immediate = false,
    reason = null,
    number = snapshot?.pr?.number,
  } = {},
) {
  const {
    viewer,
    pr,
    files,
    requiredChecks,
    openPullRequests,
    forceComment,
    checks,
    mergeQueue,
  } = snapshot ?? {};
  if (
    !positiveInteger(number) ||
    pr?.number !== number ||
    typeof pr.title !== "string" ||
    !pr.title.trim() ||
    typeof pr.body !== "string" ||
    !["OPEN", "CLOSED", "MERGED"].includes(pr.state) ||
    typeof pr.isDraft !== "boolean" ||
    typeof pr.isCrossRepository !== "boolean" ||
    typeof pr.headRefOid !== "string" ||
    !/^[a-f\d]{40}$/i.test(pr.headRefOid)
  ) {
    return refuse(
      "metadata",
      "Unable to confirm this PR's metadata and head; refusing to arm auto-merge.",
    );
  }
  if (!human(viewer))
    return refuse(
      "identity",
      "Use the workspace's own human gh identity, not a bot, to arm auto-merge.",
    );
  if (
    !Array.isArray(files) ||
    !Number.isSafeInteger(pr.changedFiles) ||
    pr.changedFiles < 0 ||
    files.length !== pr.changedFiles ||
    files.some(
      (file) =>
        typeof file?.filename !== "string" ||
        !file.filename ||
        typeof file.status !== "string" ||
        (file.previous_filename !== undefined &&
          (typeof file.previous_filename !== "string" ||
            !file.previous_filename)),
    ) ||
    new Set(files.map((file) => file.filename)).size !== files.length
  ) {
    return refuse(
      "files",
      "Unable to confirm the complete PR diff; refusing to arm auto-merge.",
    );
  }
  const paths = files.flatMap((file) =>
    file.previous_filename
      ? [file.filename, file.previous_filename]
      : [file.filename],
  );
  // These boundaries remain protected even when the shared policy is missing.
  if (
    paths.some(
      (file) =>
        file === "scripts/ci/ci-definition.mjs" ||
        file.startsWith(".github/workflows/"),
    ) ||
    (typeof isCiDefinitionPath === "function" &&
      paths.some((file) => isCiDefinitionPath(file)))
  ) {
    return refuse("ci-definition", OWNER_REVIEW);
  }
  if (SKIP_MARKER.test(pr.title) || SKIP_MARKER.test(pr.body)) {
    return refuse(
      "skip-marker",
      "This PR's title or body contains a GitHub skip marker; refusing to arm auto-merge.",
    );
  }
  if (pr.state !== "OPEN")
    return refuse("closed", "Only an open PR can be armed for auto-merge.");
  if (pr.isDraft)
    return refuse("draft", "Draft PRs cannot be armed for auto-merge.");
  if (pr.isCrossRepository)
    return refuse("fork", "PRs from forks cannot be armed for auto-merge.");
  if (
    paths.some((file) => /^\.github\/ci-incidents\/[^/]+\.json$/.test(file))
  ) {
    return refuse(
      "incident",
      "This PR changes a CI incident marker; the owner must resolve the incident and merge it.",
    );
  }
  if (
    !Array.isArray(requiredChecks) ||
    requiredChecks.some(
      (check) =>
        typeof check?.name !== "string" ||
        !CHECK_BUCKETS.has(check.bucket) ||
        typeof check.state !== "string",
    )
  ) {
    return refuse(
      "checks-unavailable",
      "Unable to confirm required checks; refusing to arm auto-merge.",
    );
  }
  if (
    requiredChecks.some(
      (check) =>
        ["fail", "cancel"].includes(check.bucket) ||
        FAILED_STATES.has(check.state.toUpperCase()),
    )
  ) {
    return refuse(
      "checks",
      "This PR has failed or cancelled required checks; refusing to arm auto-merge.",
    );
  }
  if (
    !Array.isArray(openPullRequests) ||
    openPullRequests.some(
      (other) =>
        !positiveInteger(other?.number) ||
        !validAutoMerge(other.autoMergeRequest),
    ) ||
    !openPullRequests.some((other) => other.number === number)
  ) {
    return refuse(
      "queue-unavailable",
      "Unable to confirm all open PRs; refusing to arm auto-merge.",
    );
  }
  if (
    force &&
    (!commentId(reason, number) ||
      !human(forceComment?.user) ||
      forceComment.user.login.toLowerCase() !== viewer.login.toLowerCase() ||
      typeof forceComment.html_url !== "string" ||
      typeof forceComment.issue_url !== "string" ||
      forceComment.html_url.toLowerCase() !== reason.toLowerCase() ||
      forceComment.issue_url.toLowerCase() !==
        `https://api.github.com/repos/${REPOSITORY}/issues/${number}`.toLowerCase() ||
      typeof forceComment.body !== "string" ||
      !forceComment.body.trim())
  ) {
    return refuse(
      "force-undocumented",
      "A human override requires the caller's justification comment on this PR; refusing to arm auto-merge.",
    );
  }
  const armed = openPullRequests.filter(
    (other) => other.number !== number && other.autoMergeRequest !== null,
  );
  if (armed.length && !force) {
    return refuse(
      "already-armed",
      `Another open PR already has auto-merge enabled (${armed.map((other) => `#${other.number}`).join(", ")}); wait for it to merge or be disarmed.`,
    );
  }
  if (typeof isCiDefinitionPath !== "function") {
    return refuse(
      "policy-unavailable",
      "The shared CI-definition policy is unavailable; refusing to arm auto-merge.",
    );
  }
  if (immediate) {
    if (force || reason !== null)
      return refuse(
        "immediate-force",
        "Immediate merges do not permit overrides.",
      );
    if (
      typeof pr.id !== "string" ||
      !pr.id ||
      typeof pr.baseRefName !== "string" ||
      !pr.baseRefName ||
      typeof pr.baseRefOid !== "string" ||
      !/^[a-f\d]{40}$/i.test(pr.baseRefOid) ||
      pr.mergeable !== "MERGEABLE" ||
      pr.mergeStateStatus !== "CLEAN" ||
      ![null, "APPROVED"].includes(pr.reviewDecision) ||
      pr.viewerCanMergeAsAdmin !== false
    )
      return refuse(
        "immediate-state",
        "Immediate merge requires a confirmed base, clean mergeability, satisfied review policy and no administrator bypass capability.",
      );
    if (
      mergeQueue !== null ||
      pr.isInMergeQueue !== false ||
      pr.autoMergeRequest !== null ||
      openPullRequests.some(
        (other) =>
          other.isInMergeQueue !== false || other.autoMergeRequest !== null,
      )
    )
      return refuse(
        "immediate-queue",
        "Immediate merge refuses merge-queue branches and queued or auto-armed PRs; no existing work will be cancelled.",
      );
    if (
      !requiredChecks.length ||
      requiredChecks.some(
        (check) => check.bucket !== "pass" || check.state !== "SUCCESS",
      ) ||
      !Array.isArray(checks) ||
      !checks.length ||
      checks.some(
        (check) =>
          typeof check?.name !== "string" ||
          !check.name ||
          (!(
            check.bucket === "pass" &&
            ["SUCCESS", "NEUTRAL"].includes(check.state)
          ) &&
            !(check.bucket === "skipping" && check.state === "SKIPPED")),
      ) ||
      requiredChecks.some(
        (required) =>
          !checks.some(
            (check) =>
              check.name === required.name &&
              check.bucket === required.bucket &&
              check.state === required.state,
          ),
      )
    )
      return refuse(
        "immediate-checks",
        "Immediate merge requires successful required CI and no pending, failed or unknown checks.",
      );
    return {
      allowed: true,
      code: "immediate",
      message: `Merge immediately: PR #${number} at ${pr.headRefOid} into ${pr.baseRefName}.`,
      input: {
        pullRequestId: pr.id,
        expectedHeadOid: pr.headRefOid,
        mergeMethod: "SQUASH",
        commitHeadline: `${pr.title} (#${number})`,
        commitBody: pr.body,
      },
    };
  }
  return {
    allowed: true,
    code: "arm",
    message: `Arm auto-merge for PR #${number} at ${pr.headRefOid}.`,
    args: [
      "pr",
      "merge",
      String(number),
      "--repo",
      REPOSITORY,
      "--auto",
      "--squash",
      "--match-head-commit",
      pr.headRefOid,
    ],
    subject: `${pr.title} (#${number})`,
    body: pr.body,
  };
}

function parseArguments(argv) {
  let number = null;
  let dryRun = false;
  let force = false;
  let immediate = false;
  let reason = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if (arg === "--immediate" && !immediate) immediate = true;
    else if (arg === "--force" && !force) force = true;
    else if (
      arg === "--reason" &&
      reason === null &&
      typeof argv[index + 1] === "string"
    )
      reason = argv[++index];
    else if (/^[1-9]\d*$/.test(arg) && number === null) number = Number(arg);
    else throw new Error(USAGE);
  }
  if (
    !positiveInteger(number) ||
    (immediate && force) ||
    (force ? !commentId(reason, number) : reason !== null)
  )
    throw new Error(USAGE);
  return { number, dryRun, force, reason, immediate };
}

async function loadCiDefinition() {
  try {
    const policy = await import(CI_DEFINITION_URL.href);
    return typeof policy.isCiDefinitionPath === "function"
      ? policy.isCiDefinitionPath
      : null;
  } catch {
    return null;
  }
}

/** gh is injected for tests; production always uses the normal workspace gh. */
export async function runAgentMerge(
  argv = process.argv.slice(2),
  {
    spawn = spawnSync,
    loadCiDefinition: loadPolicy = loadCiDefinition,
    stdout = console.log,
    stderr = console.error,
  } = {},
) {
  let options;
  try {
    options = parseArguments(argv);
  } catch {
    stderr(USAGE);
    return 2;
  }
  const execute = (args, statuses = [0]) => {
    const result = spawn("gh", args, {
      encoding: "utf8",
      stdio: "pipe",
      shell: false,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.signal || !statuses.includes(result.status))
      throw new Error("GitHub CLI request failed");
    return result;
  };
  const json = (args, statuses) => JSON.parse(execute(args, statuses).stdout);
  const graphql = (args) => {
    const result = json(["api", "graphql", ...args]);
    if (result?.errors || !result?.data)
      throw new Error("GraphQL result unavailable");
    return result.data;
  };
  const prNumber = String(options.number);
  const readImmediatePr = () => {
    const pr = graphql([
      "-f",
      `query=${IMMEDIATE_PR_QUERY}`,
      "-F",
      `number=${prNumber}`,
    ]).repository?.pullRequest;
    if (
      !Array.isArray(pr?.labels?.nodes) ||
      pr.labels.pageInfo?.hasNextPage !== false
    )
      throw new Error("Incomplete PR labels");
    return { ...pr, labels: pr.labels.nodes };
  };
  const samePr = (left, right) =>
    [
      "id",
      "number",
      "title",
      "body",
      "state",
      "isDraft",
      "isCrossRepository",
      "headRefOid",
      "baseRefOid",
      "baseRefName",
      "changedFiles",
    ].every((key) => left[key] === right[key]) &&
    JSON.stringify(left.labels) === JSON.stringify(right.labels);
  const readSnapshot = () => {
    const viewer = json(["api", "user"]);
    const pr = options.immediate
      ? readImmediatePr()
      : json([
          "pr",
          "view",
          prNumber,
          "--repo",
          REPOSITORY,
          "--json",
          "number,title,body,state,isDraft,isCrossRepository,headRefOid,changedFiles,labels",
        ]);
    const filePages = json([
      "api",
      `repos/${REPOSITORY}/pulls/${prNumber}/files?per_page=100`,
      "--paginate",
      "--slurp",
    ]);
    if (
      !Array.isArray(filePages) ||
      filePages.some((page) => !Array.isArray(page))
    )
      throw new Error("Incomplete file pages");
    const requiredChecks = json(
      [
        "pr",
        "checks",
        prNumber,
        "--repo",
        REPOSITORY,
        "--required",
        "--json",
        "name,bucket,state",
      ],
      [0, 1, 8],
    );
    const checks = options.immediate
      ? json(
          [
            "pr",
            "checks",
            prNumber,
            "--repo",
            REPOSITORY,
            "--json",
            "name,bucket,state",
          ],
          [0, 1, 8],
        )
      : null;
    const mergeQueue = options.immediate
      ? graphql([
          "-f",
          `query=${IMMEDIATE_QUEUE_QUERY}`,
          "-f",
          `branch=${pr.baseRefName}`,
        ]).repository?.mergeQueue
      : null;
    const openPages = json([
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${options.immediate ? OPEN_PULL_REQUESTS_QUERY.replace("nodes { number", "nodes { isInMergeQueue number") : OPEN_PULL_REQUESTS_QUERY}`,
    ]);
    if (
      !Array.isArray(openPages) ||
      !openPages.length ||
      openPages.some(
        (page) =>
          page?.errors ||
          !Array.isArray(page?.data?.repository?.pullRequests?.nodes) ||
          typeof page.data.repository.pullRequests.pageInfo?.hasNextPage !==
            "boolean" ||
          (page.data.repository.pullRequests.pageInfo.hasNextPage &&
            (typeof page.data.repository.pullRequests.pageInfo.endCursor !==
              "string" ||
              !page.data.repository.pullRequests.pageInfo.endCursor)),
      ) ||
      openPages.at(-1).data.repository.pullRequests.pageInfo?.hasNextPage ===
        true
    )
      throw new Error("Incomplete open PR pages");
    const forceComment = options.force
      ? json([
          "api",
          `repos/${REPOSITORY}/issues/comments/${commentId(options.reason, options.number)}`,
        ])
      : null;
    const freshPr = options.immediate ? readImmediatePr() : pr;
    if (!samePr(pr, freshPr)) throw new Error("PR changed during preflight");
    return {
      viewer,
      pr: freshPr,
      files: filePages.flat(),
      requiredChecks,
      checks,
      mergeQueue,
      openPullRequests: openPages.flatMap(
        (page) => page.data.repository.pullRequests.nodes,
      ),
      forceComment,
    };
  };
  let bodyDirectory;
  let immediateRequested = false;
  try {
    const policy = { ...options, isCiDefinitionPath: await loadPolicy() };
    let snapshot = readSnapshot();
    let decision = decideMerge(snapshot, policy);
    if (!decision.allowed) {
      stderr(decision.message);
      return 1;
    }
    if (options.immediate) {
      const fresh = readSnapshot();
      if (
        !samePr(snapshot.pr, fresh.pr) ||
        snapshot.viewer.login !== fresh.viewer.login
      )
        throw new Error("PR or identity changed during preflight");
      snapshot = fresh;
      decision = decideMerge(snapshot, policy);
      if (!decision.allowed) {
        stderr(decision.message);
        return 1;
      }
    }
    // Required PR checks are snapshots. Re-read the hourly main result at
    // arming time so yesterday's green check cannot authorize a cloud merge.
    const { evaluateHourly, cloudRequiredForFiles } = await import("./ci/zeros-dev-gate.mjs");
    const hourly = await evaluateHourly({ get: async (endpoint, { missing = false } = {}) => {
      if (!endpoint.startsWith(`/repos/${REPOSITORY}/`)) throw new Error("Untrusted hourly endpoint");
      if (!missing) return json(["api", endpoint.slice(1)]);
      // The repair contract proves that its marker was removed at this head.
      // gh uses exit 1 for both 404 and other API failures: inspect the HTTP
      // status, never an error message or an arbitrary response-body field.
      const result = execute(["api", endpoint.slice(1), "--include"], [0, 1]);
      const header = /^HTTP\/[0-9.]+ ([0-9]{3})[^\r\n]*\r?\n/.exec(result.stdout);
      if (result.status === 1 && header?.[1] === "404") return null;
      const boundary = /\r?\n\r?\n/.exec(result.stdout);
      if (result.status !== 0 || header?.[1] !== "200" || !boundary) throw new Error("GitHub CLI request failed");
      return JSON.parse(result.stdout.slice(boundary.index + boundary[0].length));
    } }, { cloudRequired: cloudRequiredForFiles(snapshot.files, snapshot.pr.labels ?? []), number: options.number, head: snapshot.pr.headRefOid });
    if (!hourly.allowed) {
      stderr(`The zeros-dev E2E merge gate refused this cloud PR: ${hourly.code}.`);
      return 1;
    }
    if (hourly.alert) stdout(`Noncloud PR alert: zeros-dev E2E is ${hourly.code}.`);
    if (options.immediate) {
      const pr = readImmediatePr();
      if (!samePr(snapshot.pr, pr)) throw new Error("PR changed after hourly gate");
      snapshot = { ...snapshot, pr };
      decision = decideMerge(snapshot, policy);
      if (!decision.allowed) {
        stderr(decision.message);
        return 1;
      }
      if (options.dryRun) {
        stdout(`Dry run: ${decision.message}`);
        stdout(
          `GraphQL mergePullRequest, SQUASH, expectedHeadOid=${snapshot.pr.headRefOid} (using the checked PR title and body; no auto-merge or queue admission).`,
        );
        return 0;
      }
      bodyDirectory = mkdtempSync(path.join(tmpdir(), "zeros-agent-merge-"));
      const inputFile = path.join(bodyDirectory, "input.json");
      writeFileSync(
        inputFile,
        JSON.stringify({
          query: IMMEDIATE_MUTATION,
          variables: { input: decision.input },
        }),
        { mode: 0o600 },
      );
      immediateRequested = true;
      const result = graphql(["--input", inputFile]).mergePullRequest
        ?.pullRequest;
      const confirmed = (pr) =>
        pr?.id === snapshot.pr.id &&
        pr.number === options.number &&
        pr.headRefOid === snapshot.pr.headRefOid &&
        pr.baseRefName === snapshot.pr.baseRefName &&
        pr.state === "MERGED" &&
        pr.merged === true &&
        typeof pr.mergeCommit?.oid === "string" &&
        /^[a-f\d]{40}$/i.test(pr.mergeCommit.oid) &&
        pr.autoMergeRequest === null &&
        pr.isInMergeQueue === false;
      if (!confirmed(result)) throw new Error("Merged result unavailable");
      const readback = graphql([
        "-f",
        `query=${IMMEDIATE_RESULT_QUERY}`,
        "-F",
        `number=${prNumber}`,
      ]).repository?.pullRequest;
      if (
        !confirmed(readback) ||
        readback.mergeCommit.oid !== result.mergeCommit.oid
      )
        throw new Error("Merged result unconfirmed");
      stdout(
        `Merged PR #${options.number} at ${snapshot.pr.headRefOid} into ${snapshot.pr.baseRefName}; merge commit ${readback.mergeCommit.oid}.`,
      );
      return 0;
    }
    if (options.force)
      stdout(`Human override documented at ${options.reason}.`);
    if (options.dryRun) {
      stdout(`Dry run: ${decision.message}`);
      stdout(
        `gh ${decision.args.join(" ")} (using the checked PR title and body)`,
      );
      return 0;
    }
    // Explicit commit text avoids repository squash defaults (including commit
    // messages with skip markers) and changes to the PR text after our read.
    bodyDirectory = mkdtempSync(path.join(tmpdir(), "zeros-agent-merge-"));
    const bodyFile = path.join(bodyDirectory, "body.txt");
    writeFileSync(bodyFile, decision.body, { mode: 0o600 });
    execute([
      ...decision.args,
      "--subject",
      decision.subject,
      "--body-file",
      bodyFile,
    ]);
    stdout(
      `Auto-merge requested for PR #${options.number} at ${snapshot.pr.headRefOid}.`,
    );
    return 0;
  } catch {
    // gh errors, PR text and API responses can contain credentials. Never echo
    // subprocess output or caught exception text, even after a parse failure.
    stderr(
      immediateRequested
        ? "Unable to confirm the immediate merge result. Inspect the PR before retrying; no automatic retry, auto-merge or queue admission was requested."
        : "Unable to complete the merge safety check or request; refusing to proceed. Check gh authentication, PR state and the reviewed head.",
    );
    return 1;
  } finally {
    if (bodyDirectory) rmSync(bodyDirectory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runAgentMerge();
}
