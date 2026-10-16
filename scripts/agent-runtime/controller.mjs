import { DAY, PROVIDERS, REPOSITORY } from "./config.mjs";
import {
  hash,
  invariant,
  parseJson,
  sha,
  stableVersion,
  timestamp,
  validateTask,
} from "./contracts.mjs";
import {
  labelsOf,
  ownedProposal,
  planProposal,
  recordWritten,
} from "./proposals.mjs";
import { addProposalEvent } from "./state.mjs";
import { publishPrReport } from "./publish.mjs";

export function manifestPins(text) {
  const manifest = typeof text === "string" ? parseJson(text) : text;
  const pins = Object.fromEntries(
    Object.entries(PROVIDERS).map(([id, provider]) => [
      id,
      manifest.dependencies?.[provider.package],
    ]),
  );
  invariant(
    Object.values(pins).every(stableVersion),
    "Runtime manifest pins are not exact.",
  );
  return pins;
}

/** Recover an acknowledged App commit after the writer succeeded but state did not.
 * Human-authored commits with a copied trailer are not a recovery authority. */
export function recoverBaseline(commits, provider, appSlug, previous) {
  for (const commit of [...commits].reverse()) {
    if (
      commit.committer?.type !== "Bot" ||
      commit.committer.login !== `${appSlug}[bot]` ||
      commit.commit?.verification?.verified !== true
    )
      continue;
    if (
      !new RegExp(`^Zeros-Runtime-Provider: ${provider}$`, "m").test(
        commit.commit.message ?? "",
      ) ||
      !/^Zeros-Runtime-Task: [a-f0-9]{64}$/m.test(commit.commit.message)
    )
      continue;
    invariant(sha(commit.sha), "Recovered App commit is invalid.");
    return {
      ...previous,
      lastBotCommit: commit.sha,
      lastAppliedAt: commit.commit.committer?.date ?? previous.lastAppliedAt,
    };
  }
  // A stored baseline must still belong to this PR's history after a human rebase.
  if (
    previous.lastBotCommit &&
    commits.some((commit) => commit.sha === previous.lastBotCommit)
  )
    return previous;
  return { ...previous, lastBotCommit: null };
}

export async function reconcileProposals({
  github,
  input,
  observations = [],
  pins,
  main,
  automation,
  now,
  appSlug,
  createTasks = false,
}) {
  invariant(
    sha(main) && sha(automation),
    "Controller needs immutable source commits.",
  );
  const state = structuredClone(input),
    tasks = [];
  const open = await github.pages("/pulls?state=open&base=main");
  // Handoff is explicit: even disabled Renovate branches can still contain work.
  // Keep them intact and block a competing writer until they are merged/closed.
  const legacy = open.filter(
    (pr) =>
      !pr.body?.includes("zeros-agent-runtime-proposal:v1") &&
      (labelsOf(pr).includes("agent-pin") ||
        /^renovate\/.*(?:agent-cli|claude|codex|cursor)/.test(
          pr.head?.ref ?? "",
        )),
  );
  for (const provider of Object.keys(PROVIDERS)) {
    let previous = state.proposals[provider] ?? {};
    try {
      const matches = open.filter((pr) => ownedProposal(pr, provider, appSlug));
      invariant(
        matches.length <= 1,
        "Multiple managed runtime PRs need reconciliation.",
      );
      const unknown = open.some(
        (pr) =>
          pr.head?.ref?.startsWith(`automation/agent-runtime/${provider}/`) &&
          !ownedProposal(pr, provider, appSlug),
      );
      invariant(
        !unknown,
        "An unrecognized runtime proposal needs ownership reconciliation.",
      );
      if (legacy.length) {
        state.proposals[provider] = {
          ...previous,
          status: "legacy-proposal-open",
        };
        addProposalEvent(
          state,
          provider,
          "handoff",
          legacy.map((pr) => pr.number).sort(),
          `${provider}: existing runtime maintenance PR(s) ${legacy.map((pr) => `#${pr.number}`).join(", ")} must be reconciled before enabling the new writer. Their branches remain intact.`,
          now,
        );
        continue;
      }
      const openPr = matches[0]
        ? {
            ...(await github.get(`/pulls/${matches[0].number}`)),
            ...(await github.mergeState(matches[0].number)),
          }
        : null;
      let closedPr = null,
        headVersion,
        closedHeadVersion;
      if (previous.pr && !openPr) {
        closedPr = await github.get(`/pulls/${previous.pr}`);
        invariant(
          ownedProposal(closedPr, provider, appSlug) &&
            closedPr.state === "closed",
          "The recorded proposal is no longer a recognized closed PR.",
        );
        if (closedPr.merged_at && sha(closedPr.merge_commit_sha))
          previous.mergedCommit = closedPr.merge_commit_sha;
        if (!closedPr.merged_at) {
          invariant(sha(closedPr.head?.sha), "Invalid closed PR head.");
          closedHeadVersion = manifestPins(
            await github.file("package.json", closedPr.head.sha),
          )[provider];
        }
      }
      if (openPr) {
        headVersion = manifestPins(
          await github.file("package.json", openPr.head.sha),
        )[provider];
        const commits = await github.pages(`/pulls/${openPr.number}/commits`);
        previous = recoverBaseline(commits, provider, appSlug, previous);
        const integration = [...commits]
          .reverse()
          .find((commit) => commit.committer?.type !== "Bot");
        const progress = `${openPr.number}:${integration?.sha ?? "creation"}`;
        if (previous.reviewProgress !== progress) {
          const changedAt =
            integration?.commit?.committer?.date ?? openPr.created_at;
          previous.reviewProgress = progress;
          previous.reviewProgressAt =
            timestamp(changedAt) && Date.parse(changedAt) <= Date.parse(now)
              ? changedAt
              : now;
          previous.reviewReminderWeek = null;
        }
      }
      if (!openPr && !closedPr && previous.pendingTask && createTasks) {
        const pending = validateTask(previous.pendingTask);
        let ref = null;
        try {
          ref = await github.get(`/git/ref/heads/${pending.branch}`);
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        if (ref) {
          const { id: oldId, ...identity } = pending;
          identity.automation = automation;
          identity.createdAt = now;
          identity.recoveryTaskId = pending.recoveryTaskId ?? oldId;
          const recovery = validateTask({ ...identity, id: hash(identity) });
          tasks.push(recovery);
          state.proposals[provider] = {
            ...previous,
            pendingTask: recovery,
            status: "recovering-creation",
          };
          continue;
        }
      }
      const registry =
        observations.find(
          (observation) => observation.id === `${provider}-registry`,
        ) ?? state.sources[`${provider}-registry`]?.lastGood;
      const planned = planProposal({
        provider,
        registry: registry
          ? { ...registry, data: { ...registry.data, pin: pins[provider] } }
          : null,
        previous,
        openPr,
        headVersion,
        closedPr,
        closedHeadVersion,
        main,
        automation,
        now,
      });
      if (
        planned.task &&
        openPr &&
        !previous.lastBotCommit &&
        !planned.task.regenerate
      ) {
        planned.task = null;
        planned.proposal.status = "baseline-unavailable";
      }
      if (!createTasks && planned.task) {
        const sameBlockedInput =
          previous.lastAttempt?.key ===
            hash([planned.task.head, planned.task.version]) &&
          ["preparation-blocked", "preparation-incomplete"].includes(
            previous.status,
          );
        planned.task = null;
        planned.proposal.lastAttempt = previous.lastAttempt ?? null;
        planned.proposal.pendingTask = previous.pendingTask ?? null;
        planned.proposal.status = sameBlockedInput
          ? previous.status
          : openPr
            ? "update-available"
            : "candidate-available";
      }
      state.proposals[provider] = planned.proposal;
      if (planned.task) tasks.push(planned.task);
      if (
        planned.proposal.status !== previous.status &&
        [
          "held",
          "baseline-unavailable",
          "preparation-blocked",
          "registry-rollback",
          "platform-evidence-incomplete",
          "declined",
        ].includes(planned.proposal.status)
      )
        addProposalEvent(
          state,
          provider,
          "proposal-status",
          [
            planned.proposal.pr ?? null,
            planned.proposal.status,
            planned.proposal.head ?? main,
          ],
          `${provider}: ${planned.proposal.status}${planned.proposal.pr ? ` on #${planned.proposal.pr}` : ""}.`,
          now,
          planned.proposal.status === "held" ? "info" : "warning",
        );
      const reviewAge = Date.parse(now) - Date.parse(previous.reviewProgressAt);
      if (
        openPr &&
        planned.proposal.status !== "held" &&
        reviewAge >= 2 * DAY
      ) {
        const week = Math.floor(reviewAge / (7 * DAY));
        if (planned.proposal.reviewReminderWeek !== week) {
          planned.proposal.reviewReminderWeek = week;
          addProposalEvent(
            state,
            provider,
            "review-age",
            [previous.reviewProgress, week],
            `${provider}: #${openPr.number} has no new integration commit for at least ${week ? `${week * 7} days` : "48 hours"}. Review the pending decisions on the same PR; mechanical bot advances do not resolve them.`,
            now,
          );
        }
      }
    } catch {
      state.proposals[provider] = {
        ...previous,
        status: "reconciliation-blocked",
      };
      addProposalEvent(
        state,
        provider,
        "reconciliation",
        [previous.pr ?? null, previous.head ?? main],
        `${provider}: proposal ownership, history or merge-state evidence is incomplete; branch updates are paused.`,
        now,
      );
    }
  }
  return { state, tasks };
}

export function compactReport(report) {
  return {
    schema: 1,
    head: report.head,
    testedHead: report.testedHead ?? null,
    provider: report.provider ?? null,
    version: report.version ?? null,
    gates: report.gates ?? [],
    changes: (report.changes ?? [])
      .slice(0, 20)
      .map(({ kind, subject, disposition }) => ({
        kind,
        subject: subject.slice(0, 300),
        disposition: disposition ?? null,
      })),
    summary: report.summary?.slice(0, 1200) ?? null,
    runUrl: report.runUrl ?? null,
  };
}

export async function refreshPrReports(
  github,
  state,
  { trackingIssue = null, updatesEnabled = true } = {},
) {
  let failed = false;
  for (const [provider, proposal] of Object.entries(state.proposals)) {
    if (!proposal.pr || !sha(proposal.head)) continue;
    const report =
      proposal.report?.head === proposal.head
        ? proposal.report
        : {
            head: proposal.head,
            testedHead: null,
            provider,
            version: proposal.version,
            gates: [],
            changes: [],
            summary: `${provider}: ${proposal.status}. Qualification of this head is pending.`,
          };
    const signals = Object.values(state.events)
      .filter(
        (event) =>
          event.provider === provider &&
          [
            "upstream-notes",
            "release-notes",
            "model-change",
            "model-unavailable",
            "security",
            "runtime-contract",
          ].includes(event.kind),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8);
    try {
      await publishPrReport(github, proposal.pr, report, {
        held: proposal.status === "held",
        status: proposal.status,
        updatesEnabled,
        frozenHead: proposal.frozenHead,
        queued: proposal.queued,
        signals,
        trackingIssue,
      });
    } catch {
      failed = true;
    }
  }
  invariant(
    !failed,
    "One or more PR reports could not be refreshed; the other providers were still attempted.",
  );
}

export function finalizeResults(input, tasks, results, now, runUrl) {
  const state = structuredClone(input);
  for (const raw of tasks) {
    const task = validateTask(raw),
      result = results.find((value) => value.taskId === task.id);
    const previous = state.proposals[task.provider] ?? {};
    const written = result ?? {
      taskId: task.id,
      status: "preparation-incomplete",
    };
    const proposal = recordWritten(previous, task, written, now);
    if (written.status === "written") {
      proposal.report = compactReport({
        head: written.head,
        testedHead: null,
        provider: task.provider,
        version: task.version,
        gates: written.report?.gates ?? [],
        changes: written.report?.changes ?? [],
        runUrl,
        summary:
          "Mechanical update appended to this PR. Required CI is pending on the actual pushed commit; preparation is not qualification.",
      });
      addProposalEvent(
        state,
        task.provider,
        "proposal-written",
        [written.pr, written.head],
        `${task.provider}: ${task.version} appended to #${written.pr}; continue integration on that same branch.`,
        now,
        "info",
      );
    } else
      addProposalEvent(
        state,
        task.provider,
        "proposal-blocked",
        [task.id, written.status],
        `${task.provider}: automatic update ${written.status}. Resolve on the working PR; no branch was reset.`,
        now,
      );
    state.proposals[task.provider] = proposal;
  }
  return state;
}

export function workflowContext(env = process.env) {
  const id = Number(env.GITHUB_RUN_ID),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  invariant(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_REPOSITORY?.toLowerCase() === REPOSITORY.toLowerCase() &&
      env.GITHUB_REF === "refs/heads/main" &&
      sha(env.GITHUB_SHA) &&
      Number.isSafeInteger(id) &&
      id > 0 &&
      Number.isSafeInteger(attempt) &&
      attempt > 0,
    "Publishing requires the trusted default-branch workflow.",
  );
  return {
    id,
    attempt,
    head: env.GITHUB_SHA,
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/${id}/attempts/${attempt}`,
  };
}

export function preparedEnvelope(task, result, run) {
  return {
    schema: 1,
    taskId: task.id,
    runId: run.id,
    attempt: run.attempt,
    automation: task.automation,
    result,
    digest: hash(result),
  };
}

export function validatePrepared(value, task, run) {
  validateTask(task);
  invariant(
    value?.schema === 1 &&
      value.taskId === task.id &&
      value.runId === run.id &&
      value.attempt === run.attempt &&
      value.automation === task.automation &&
      value.digest === hash(value.result),
    "Prepared artifact identity mismatch.",
  );
  invariant(
    ["prepared", "blocked", "unchanged"].includes(value.result?.status),
    "Prepared artifact status is invalid.",
  );
  return value.result;
}

export async function confirmWrittenResults(github, tasks, results, appSlug) {
  const confirmed = [];
  for (const task of tasks) {
    validateTask(task);
    // Result artifacts are informational. GitHub's signed App commit and owned
    // PR independently establish that a write happened, including lost replies.
    const prs = task.pr
      ? [await github.get(`/pulls/${task.pr}`)]
      : await github.pages(
          `/pulls?state=all&head=${encodeURIComponent(`${REPOSITORY.split("/")[0]}:${task.branch}`)}`,
        );
    const pr = prs.find((pr) => ownedProposal(pr, task.provider, appSlug));
    const supplied = results.find((result) => result.taskId === task.id);
    // Stopped outcomes are informational only. They never authorize a write or
    // establish a baseline, and only this closed vocabulary reaches the report.
    const stopped = {
      taskId: task.id,
      provider: task.provider,
      status: [
        "preparation-blocked",
        "held",
        "closed",
        "closed-after-write",
        "stale-head",
      ].includes(supplied?.status)
        ? supplied.status
        : "preparation-incomplete",
    };
    if (!pr) {
      confirmed.push(stopped);
      continue;
    }
    const commits = await github.pages(`/pulls/${pr.number}/commits`);
    const commit = [...commits]
      .reverse()
      .find(
        (commit) =>
          commit.committer?.type === "Bot" &&
          commit.committer.login === `${appSlug}[bot]` &&
          commit.commit?.verification?.verified === true &&
          commit.commit.message?.includes(
            `Zeros-Runtime-Task: ${task.recoveryTaskId ?? task.id}`,
          ) &&
          commit.parents?.length === 1 &&
          commit.parents[0].sha === task.head,
      );
    if (
      !commit ||
      manifestPins(await github.file("package.json", commit.sha))[
        task.provider
      ] !== task.version
    ) {
      confirmed.push(stopped);
      continue;
    }
    confirmed.push({
      taskId: task.id,
      provider: task.provider,
      status: "written",
      pr: pr.number,
      head: commit.sha,
      ...(supplied?.head === commit.sha && supplied.report
        ? { report: supplied.report }
        : {}),
    });
  }
  return confirmed;
}
