import { PROVIDERS, REPOSITORY } from "./config.mjs";
import { invariant, sha } from "./contracts.mjs";
import { readArtifact, validateRun } from "./artifacts.mjs";
import { runJobs } from "./delivery.mjs";
import { GATES, validateQualification } from "./qualification.mjs";
import { compactReport, manifestPins } from "./controller.mjs";
import { ownedProposal } from "./proposals.mjs";

/** Trusted workflow_run consumer. The only candidate input parsed here is JSON. */
export async function acceptPrEvidence(
  github,
  state,
  { id, attempt, appSlug },
) {
  const run = await github.get(`/actions/runs/${id}`);
  validateRun(run, {
    id,
    attempt,
    workflow: "ci.yml",
    events: ["pull_request"],
    completed: true,
  });
  const definition = await github.get("/actions/workflows/ci.yml");
  invariant(
    run.workflow_id === definition.id,
    "Qualification workflow identity changed.",
  );
  if (run.conclusion === "cancelled") return { state, status: "cancelled" };
  invariant(
    Array.isArray(run.pull_requests) && run.pull_requests.length === 1,
    "Qualification has no unique PR association.",
  );
  const association = run.pull_requests[0],
    pr = await github.get(`/pulls/${association.number}`);
  if (
    pr.state !== "open" ||
    pr.head.sha !== run.head_sha ||
    association.head?.sha !== run.head_sha
  )
    return { state, status: "stale" };
  const provider = Object.keys(PROVIDERS).find((provider) =>
    ownedProposal(pr, provider, appSlug),
  );
  if (!provider) return { state, status: "unmanaged" };
  invariant(
    sha(association.base?.sha),
    "Qualification base association is incomplete.",
  );
  const result = structuredClone(state),
    previous = result.proposals[provider] ?? {};
  if (
    previous.report?.head === pr.head.sha &&
    (previous.report.runId > id ||
      (previous.report.runId === id && previous.report.attempt > attempt))
  )
    return { state, status: "superseded" };
  let report;
  try {
    const raw = await readArtifact(
      github,
      run,
      `agent-runtime-qualification-${id}-${attempt}`,
      "report.json",
    );
    invariant(sha(raw.testedHead), "Qualification has no tested commit.");
    const tested = await github.get(`/git/commits/${raw.testedHead}`);
    invariant(
      tested.sha === raw.testedHead &&
        tested.parents?.length === 2 &&
        tested.parents[0].sha === association.base.sha &&
        tested.parents[1].sha === pr.head.sha,
      "Qualification merge parents do not match the run's source/base.",
    );
    report = validateQualification(raw, {
      run,
      pr: pr.number,
      head: pr.head.sha,
      testedHead: tested.sha,
      base: association.base.sha,
    });
    const jobs = await runJobs(github, run);
    const job = jobs.find(
      (job) =>
        job.run_attempt === attempt &&
        /(?:^|\/ )agent-runtime-qualification$/.test(job.name),
    );
    invariant(
      job &&
        job.steps?.some(
          (step) =>
            step.name === "Save runtime qualification report" &&
            step.conclusion === "success",
        ),
      "Qualification artifact has no completed producer.",
    );
    if (report.gates.every((gate) => gate.status === "passed"))
      invariant(
        job.conclusion === "success",
        "Runtime producer did not succeed.",
      );
  } catch {
    report = {
      schema: 1,
      head: pr.head.sha,
      testedHead: null,
      gates: GATES.map((name) => ({
        name,
        status: "incomplete",
        exitCode: null,
      })),
      changes: [],
      summary:
        "Current-head runtime evidence is missing, invalid or incomplete. Review the workflow; missing evidence is not a pass.",
    };
  }
  const runUrl = `https://github.com/${REPOSITORY}/actions/runs/${id}/attempts/${attempt}`;
  const version = manifestPins(await github.file("package.json", pr.head.sha))[
    provider
  ];
  result.proposals[provider] = {
    ...previous,
    pr: pr.number,
    branch: pr.head.ref,
    head: pr.head.sha,
    report: {
      ...compactReport({ ...report, provider, version, runUrl }),
      runId: id,
      attempt,
    },
  };
  return { state: result, status: "accepted" };
}

export async function refreshLatestPrEvidence(github, input, appSlug) {
  let state = input;
  for (const proposal of Object.values(input.proposals)) {
    if (!proposal.pr || !sha(proposal.head)) continue;
    // GitHub may replace a pending concurrency-group run. Every public scan can
    // recover its missed workflow_run delivery from immutable CI evidence.
    const value = await github.get(
      `/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${proposal.head}&per_page=5`,
    );
    invariant(
      Array.isArray(value.workflow_runs),
      "Runtime evidence run listing changed shape.",
    );
    const latest = value.workflow_runs
      .filter(
        (run) =>
          run.head_sha === proposal.head &&
          run.status === "completed" &&
          run.conclusion !== "cancelled",
      )
      .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
    if (
      !latest ||
      (proposal.report?.runId === latest.id &&
        proposal.report.attempt === latest.run_attempt)
    )
      continue;
    const accepted = await acceptPrEvidence(github, state, {
      id: latest.id,
      attempt: latest.run_attempt,
      appSlug,
    });
    state = accepted.state;
  }
  return state;
}
