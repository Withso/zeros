import {
  HOLD_LABEL,
  LABELS,
  LIMITS,
  REGENERATE_LABEL,
  REPOSITORY,
} from "./config.mjs";
import { hash, invariant, timestamp } from "./contracts.mjs";
import { trustedComment } from "./github.mjs";
import {
  BODY_END,
  BODY_START,
  PR_MARKER,
  TRACKING_MARKER,
  renderDashboard,
  renderDigest,
  renderPrReport,
  updateOwnedDashboard,
} from "./report.mjs";
import {
  CHECKPOINT_MARKER,
  STATE_MARKER,
  acknowledgeEvents,
  compactState,
  decodeState,
  dueEvents,
  encodeState,
  initialState,
  reconcileDigests,
  validateState,
} from "./state.mjs";

export async function loadTracking(github, number, now) {
  invariant(
    Number.isSafeInteger(number) && number > 0,
    "Configure the runtime tracking issue number.",
  );
  const issue = await github.get(`/issues/${number}`);
  invariant(
    !issue.pull_request &&
      issue.state === "open" &&
      issue.body?.includes(TRACKING_MARKER),
    "Tracking issue is unavailable or not initialized.",
  );
  const locator = /<!-- zeros-agent-runtime-state-comment:(\d+) -->/.exec(
    issue.body,
  );
  invariant(
    locator,
    "Durable state locator is missing; do not bootstrap over it.",
  );
  const stateComment = await github.get(`/issues/comments/${locator[1]}`);
  invariant(
    trustedComment(stateComment, number),
    "State comment is not owned by the trusted publisher.",
  );
  const state = decodeState(stateComment.body);
  const since = new Date(
    Date.parse(state.publishedAt ?? state.createdAt) - 3 * 86_400_000,
  ).toISOString();
  const comments = (
    await github.pages(
      `/issues/${number}/comments?since=${encodeURIComponent(since)}`,
    )
  ).filter((comment) => trustedComment(comment, number));
  return {
    issue,
    stateComment,
    state: reconcileDigests(state, comments),
    comments,
    now,
  };
}

export async function bootstrapTracking(github, now) {
  invariant(timestamp(now), "Invalid bootstrap time.");
  const issues = await github.pages(
    "/issues?state=open&creator=github-actions%5Bbot%5D",
  );
  const existing = issues.filter(
    (issue) => !issue.pull_request && issue.body?.includes(TRACKING_MARKER),
  );
  invariant(
    existing.length <= 1,
    "Multiple runtime tracking issues require reconciliation.",
  );
  let issue = existing[0];
  if (issue?.body?.includes("zeros-agent-runtime-state-comment:"))
    return loadTracking(github, issue.number, now);
  if (!issue)
    issue = await github.post("/issues", {
      title: "Agent SDK, CLI, model and capability updates",
      body: `${TRACKING_MARKER}\n${BODY_START}\nInitializing durable state.\n${BODY_END}`,
    });
  const comments = (
    await github.pages(`/issues/${issue.number}/comments`)
  ).filter(
    (comment) =>
      trustedComment(comment, issue.number) &&
      comment.body?.startsWith(STATE_MARKER),
  );
  invariant(
    comments.length <= 1,
    "Multiple state comments require reconciliation.",
  );
  const stateComment =
    comments[0] ??
    (await github.post(`/issues/${issue.number}/comments`, {
      body: encodeState(initialState(now)),
    }));
  const state = decodeState(stateComment.body);
  const body = renderDashboard(state, stateComment.id);
  issue = await github.patch(`/issues/${issue.number}`, { body });
  return { issue, stateComment, state, comments: [], now };
}

export async function ensureControlLabels(github) {
  for (const name of [...LABELS, HOLD_LABEL, REGENERATE_LABEL]) {
    try {
      await github.get(`/labels/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        await github.post("/labels", {
          name,
          color: "c5def5",
          description:
            name === HOLD_LABEL
              ? "Pause automatic runtime updates for final review"
              : name === REGENERATE_LABEL
                ? "Allow reviewed regeneration of managed runtime files"
                : "Automated dependency maintenance",
        });
      } catch (createError) {
        if (createError.status !== 422) throw createError;
        await github.get(`/labels/${encodeURIComponent(name)}`);
      }
    }
  }
}

async function publishOnce(github, issue, body, marker, now) {
  try {
    return await github.post(`/issues/${issue}/comments`, { body });
  } catch (error) {
    // POST may have succeeded even if its response was lost. Never retry it blindly.
    const since = new Date(Date.parse(now) - 86_400_000).toISOString();
    const comments = await github.pages(
      `/issues/${issue}/comments?since=${encodeURIComponent(since)}`,
    );
    const posted = comments.find(
      (comment) =>
        trustedComment(comment, issue) && comment.body?.startsWith(marker),
    );
    if (posted) return posted;
    throw error;
  }
}

async function publishCheckpoint(github, number, snapshot, now) {
  const digest = hash(snapshot);
  const marker = `${CHECKPOINT_MARKER}\n<!-- checkpoint-digest:${digest} -->`;
  const json = JSON.stringify(snapshot);
  const body = `${marker}\n\`\`\`json\n${json}\n\`\`\``;
  if (Buffer.byteLength(body) <= LIMITS.comment) {
    return publishOnce(github, number, body, marker, now);
  }
  // A long outage can produce more history than a single comment holds. Keep
  // every acknowledged event in bounded parts before advancing durable state.
  const bytes = Buffer.from(json),
    parts = [];
  invariant(
    bytes.length <= LIMITS.report,
    "Checkpoint exceeds the catch-up bound.",
  );
  const partSize = 30 * 1024,
    total = Math.ceil(bytes.length / partSize);
  for (let index = 0; index < total; index++) {
    const part = bytes.subarray(index * partSize, (index + 1) * partSize);
    const partMarker = `<!-- zeros-agent-runtime-checkpoint-part:v1 ${digest} ${index} -->`;
    const data = {
      schema: 1,
      digest,
      index,
      total,
      data: part.toString("base64"),
    };
    const comment = await publishOnce(
      github,
      number,
      `${partMarker}\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
      partMarker,
      now,
    );
    parts.push({ comment: comment.id, sha256: hash(part) });
  }
  const index = { schema: 1, encoding: "base64-json-parts", digest, parts };
  return publishOnce(
    github,
    number,
    `${marker}\n\`\`\`json\n${JSON.stringify(index)}\n\`\`\``,
    marker,
    now,
  );
}

export async function publishTracking(github, tracking, input, now) {
  let state = structuredClone(validateState(input, { transient: true }));
  const number = tracking.issue.number;
  const current = await github.get(
    `/issues/comments/${tracking.stateComment.id}`,
  );
  invariant(
    trustedComment(current, number) &&
      current.body === tracking.stateComment.body,
    "Tracking state moved during publication; retry from the new snapshot.",
  );
  // Reconcile after reduction as well: a previous run may have posted events
  // which never made it into the durable snapshot loaded at the start of this run.
  const since = new Date(
    Date.parse(tracking.state.publishedAt ?? tracking.state.createdAt) -
      3 * 86_400_000,
  ).toISOString();
  state = reconcileDigests(
    state,
    (
      await github.pages(
        `/issues/${number}/comments?since=${encodeURIComponent(since)}`,
      )
    ).filter((comment) => trustedComment(comment, number)),
  );
  // Bounded batches keep large catch-up scans below GitHub's comment limit.
  const pending = dueEvents(state);
  for (let offset = 0; offset < pending.length; offset += 20) {
    const events = pending.slice(offset, offset + 20);
    const body = renderDigest(events);
    await publishOnce(github, number, body, body.split("\n")[0], now);
    state = acknowledgeEvents(
      state,
      events.map((event) => event.id),
      now,
    );
  }
  const compacted = compactState(state, now);
  if (compacted.checkpoint) {
    const checkpoint = await publishCheckpoint(
      github,
      number,
      compacted.checkpoint,
      now,
    );
    compacted.state.checkpoint = checkpoint.id;
  }
  state = compacted.state;
  state.publishedAt = now;
  const body = encodeState(state);
  // Workflow-wide serialization is mandatory: the issue API has no compare-and-swap PATCH.
  await github.patch(`/issues/comments/${tracking.stateComment.id}`, { body });
  const latestIssue = await github.get(`/issues/${number}`);
  await github.patch(`/issues/${number}`, {
    body: updateOwnedDashboard(
      latestIssue.body,
      renderDashboard(state, tracking.stateComment.id),
    ),
  });
  return state;
}

export async function publishPrReport(github, number, report, controls = {}) {
  const pr = await github.get(`/pulls/${number}`);
  if (pr.state === "closed") return { status: "closed" };
  invariant(
    pr.head?.repo?.full_name?.toLowerCase() === REPOSITORY.toLowerCase(),
    "Report PR belongs to a fork.",
  );
  if (pr.head.sha !== report.head) return { status: "stale" };
  const comments = (await github.pages(`/issues/${number}/comments`)).filter(
    (comment) =>
      trustedComment(comment, number) && comment.body?.startsWith(PR_MARKER),
  );
  invariant(
    comments.length <= 1,
    "Multiple owned PR reports require reconciliation.",
  );
  const body = renderPrReport(report, controls);
  // Check again after pagination; another push may have invalidated the report.
  if ((await github.get(`/pulls/${number}`)).head.sha !== report.head)
    return { status: "stale" };
  if (comments[0])
    await github.patch(`/issues/comments/${comments[0].id}`, { body });
  else
    await publishOnce(
      github,
      number,
      body,
      PR_MARKER,
      new Date().toISOString(),
    );
  return { status: "published" };
}

export async function publishHealth(github, number, findings, now) {
  const issue = await github.get(`/issues/${number}`);
  invariant(
    !issue.pull_request &&
      issue.state === "open" &&
      issue.body?.includes(TRACKING_MARKER),
    "The watchdog tracking issue is unavailable.",
  );
  const prefix = "<!-- zeros-agent-runtime-health:v1 ";
  const comments = (
    await github.pages(
      `/issues/${number}/comments?since=${encodeURIComponent(new Date(Date.parse(now) - 30 * 86_400_000).toISOString())}`,
    )
  )
    .filter(
      (comment) =>
        trustedComment(comment, number) && comment.body?.startsWith(prefix),
    )
    .sort((a, b) => b.id - a.id);
  const digest = hash(findings),
    marker = `${prefix}${digest} -->`;
  if (
    comments[0]?.body?.startsWith(marker) ||
    (!comments.length && findings.length === 0)
  )
    return;
  const body = `${marker}\n${findings.length ? "Runtime notification health needs attention." : "Runtime notification health recovered."}\n\n${findings.map((finding) => `- ${finding}`).join("\n")}\n\nCheck the Agent runtime radar and model-discovery workflows. This independent watchdog does not repair or reset durable state.`;
  await publishOnce(github, number, body, marker, now);
}
