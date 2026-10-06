#!/usr/bin/env node
// Arm auto-merge with the workspace's own gh identity and the checked PR head.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "Withso/zeros";
const OWNER_REVIEW =
  "This PR changes CI definitions; the owner must review and merge it.";
const USAGE =
  "usage: pnpm agent:merge <pr-number> [--dry-run] [--force --reason <human-PR-comment-URL>]";
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
    reason = null,
    number = snapshot?.pr?.number,
  } = {},
) {
  const { viewer, pr, files, requiredChecks, openPullRequests, forceComment } =
    snapshot ?? {};
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
  let reason = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run" && !dryRun) dryRun = true;
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
    (force ? !commentId(reason, number) : reason !== null)
  )
    throw new Error(USAGE);
  return { number, dryRun, force, reason };
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
  let bodyDirectory;
  try {
    const prNumber = String(options.number);
    const viewer = json(["api", "user"]);
    const pr = json([
      "pr",
      "view",
      prNumber,
      "--repo",
      REPOSITORY,
      "--json",
      "number,title,body,state,isDraft,isCrossRepository,headRefOid,changedFiles",
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
    const openPages = json([
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${OPEN_PULL_REQUESTS_QUERY}`,
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
    const decision = decideMerge(
      {
        viewer,
        pr,
        files: filePages.flat(),
        requiredChecks,
        openPullRequests: openPages.flatMap(
          (page) => page.data.repository.pullRequests.nodes,
        ),
        forceComment,
      },
      { ...options, isCiDefinitionPath: await loadPolicy() },
    );
    if (!decision.allowed) {
      stderr(decision.message);
      return 1;
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
      `Auto-merge requested for PR #${options.number} at ${pr.headRefOid}.`,
    );
    return 0;
  } catch {
    // gh errors, PR text and API responses can contain credentials. Never echo
    // subprocess output or caught exception text, even after a parse failure.
    stderr(
      "Unable to complete the merge safety check or request; refusing to proceed. Check gh authentication, PR state and the reviewed head.",
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
