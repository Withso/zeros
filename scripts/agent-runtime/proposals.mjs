import {
  BRANCH_PREFIX,
  DAY,
  HOLD_LABEL,
  PROVIDERS,
  REGENERATE_LABEL,
  REPOSITORY,
  SCHEMA,
} from "./config.mjs";
import {
  compareVersions,
  hash,
  invariant,
  sha,
  stableVersion,
  validateTask,
} from "./contracts.mjs";

export const PROPOSAL_MARKER = "zeros-agent-runtime-proposal:v1";

export function proposalMarker(provider, branch) {
  return `<!-- ${PROPOSAL_MARKER} ${provider} ${branch} -->`;
}
export function labelsOf(pr) {
  return (pr.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}
export function held(pr) {
  return (
    labelsOf(pr).includes(HOLD_LABEL) ||
    Boolean(pr.auto_merge || pr.mergeQueueEntry)
  );
}

/** GitHub signs commits an App creates through the API: the App is the author
 * and GitHub's web-flow account the committer. A push keeps its own committer,
 * and a web-UI edit keeps its human author, so neither can pass as the App. */
export function appCommit(commit, appSlug) {
  const app = `${appSlug}[bot]`;
  return (
    commit?.author?.type === "Bot" &&
    commit.author.login === app &&
    commit.commit?.verification?.verified === true &&
    ((commit.committer?.type === "User" &&
      commit.committer.login === "web-flow") ||
      (commit.committer?.type === "Bot" && commit.committer.login === app))
  );
}

export function ownedProposal(pr, provider, appSlug) {
  return (
    pr?.head?.repo?.full_name?.toLowerCase() === REPOSITORY.toLowerCase() &&
    pr.base?.ref === "main" &&
    pr.user?.type === "Bot" &&
    pr.user.login === `${appSlug}[bot]` &&
    new RegExp(`^${BRANCH_PREFIX}${provider}/[a-f0-9]{12}$`).test(
      pr.head.ref,
    ) &&
    pr.body?.includes(proposalMarker(provider, pr.head.ref))
  );
}

/** A proposal is a working branch shared with maintainers, not a regenerable diff. */
export function planProposal({
  provider,
  registry,
  previous = {},
  openPr = null,
  headVersion,
  closedPr = null,
  closedHeadVersion,
  main,
  automation,
  now,
}) {
  invariant(
    Object.hasOwn(PROVIDERS, provider) && sha(main) && sha(automation),
    "Invalid proposal context.",
  );
  const proposal = { ...previous };
  const finish = (status, task = null) => ({
    proposal: { ...proposal, status },
    task,
  });
  if (closedPr) {
    if (!closedPr.merged_at) {
      invariant(
        stableVersion(closedHeadVersion),
        "Incomplete closed PR pin evidence.",
      );
      proposal.declined = closedHeadVersion;
      proposal.version = closedHeadVersion;
    }
    proposal.pr = null;
    proposal.branch = null;
    proposal.lastBotCommit = null;
    proposal.lastAttempt = null;
    proposal.lastAppliedAt = null;
    proposal.frozenHead = null;
    proposal.pendingTask = null;
  }
  if (openPr) {
    invariant(
      openPr.state === "open" &&
        sha(openPr.head?.sha) &&
        stableVersion(headVersion),
      "Incomplete working PR snapshot.",
    );
    proposal.pr = openPr.number;
    proposal.branch = openPr.head.ref;
    proposal.version = headVersion;
    proposal.head = openPr.head.sha;
    proposal.queued =
      registry?.data?.candidate &&
      compareVersions(registry.data.candidate, headVersion) > 0
        ? registry.data.candidate
        : null;
    if (held(openPr)) {
      // The caller holds the writer's workflow concurrency lock before acknowledging.
      proposal.frozenHead = openPr.head.sha;
      return finish("held");
    }
    proposal.frozenHead = null;
  }
  if (registry?.status !== "complete") return finish("source-incomplete");
  const { candidate, latest, pin, installable } = registry.data;
  const from = headVersion ?? pin;
  invariant(stableVersion(from), "Invalid shipping or working pin.");
  const regenerate = Boolean(
    openPr && labelsOf(openPr).includes(REGENERATE_LABEL),
  );
  if (!candidate || compareVersions(candidate, from) < 0)
    return finish(
      compareVersions(latest, from) < 0
        ? "registry-rollback"
        : "awaiting-release-age",
    );
  if (compareVersions(candidate, from) === 0 && !regenerate)
    return finish(openPr ? "awaiting-integration" : "current");
  if (!openPr && proposal.declined === candidate) return finish("declined");
  if (installable !== true) return finish("platform-evidence-incomplete");
  if (
    !regenerate &&
    proposal.lastAppliedAt &&
    Date.parse(now) - Date.parse(proposal.lastAppliedAt) < DAY
  )
    return finish("queued-for-daily-refresh");
  const head = openPr?.head.sha ?? main;
  const attemptKey = hash([head, candidate]);
  if (
    !regenerate &&
    proposal.lastAttempt?.key === attemptKey &&
    proposal.lastAttempt.count >= 3
  )
    return finish("preparation-blocked");
  const branch =
    openPr?.head.ref ??
    `${BRANCH_PREFIX}${provider}/${hash([provider, main, candidate]).slice(0, 12)}`;
  const createdAt =
    !regenerate && proposal.lastAttempt?.key === attemptKey
      ? proposal.lastAttempt.createdAt
      : now;
  const identity = {
    schema: SCHEMA,
    provider,
    from,
    version: candidate,
    head,
    main,
    automation,
    branch,
    pr: openPr?.number ?? null,
    lastBotCommit: regenerate ? head : (proposal.lastBotCommit ?? null),
    regenerate,
    createdAt,
  };
  const task = validateTask({ ...identity, id: hash(identity) });
  proposal.lastAttempt = {
    key: attemptKey,
    count:
      proposal.lastAttempt?.key === attemptKey
        ? proposal.lastAttempt.count + 1
        : 1,
    at: now,
    createdAt,
  };
  proposal.branch = branch;
  proposal.queued = candidate;
  proposal.pendingTask = task;
  return finish("preparing", task);
}

export function recordWritten(previous, task, result, now) {
  invariant(
    result.taskId === task.id,
    "Writer result does not match the preparation task.",
  );
  if (result.status !== "written")
    return { ...previous, status: result.status, blockedAt: now };
  invariant(
    sha(result.head) && Number.isSafeInteger(result.pr) && result.pr > 0,
    "Writer result is incomplete.",
  );
  return {
    ...previous,
    pr: result.pr,
    branch: task.branch,
    head: result.head,
    version: task.version,
    lastBotCommit: result.head,
    lastAppliedAt: now,
    lastAttempt: null,
    pendingTask: null,
    queued: null,
    status: "awaiting-integration",
    frozenHead: null,
  };
}
