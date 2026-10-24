import { describe, expect, it, vi } from "vitest";
import { hash } from "../agent-runtime/contracts.mjs";
import {
  confirmWrittenResults,
  finalizeResults,
  preparedEnvelope,
  reconcileProposals,
  recoverBaseline,
  refreshPrReports,
  validatePrepared,
  workflowContext,
} from "../agent-runtime/controller.mjs";
import { proposalMarker } from "../agent-runtime/proposals.mjs";
import { initialState, reduceObservations } from "../agent-runtime/state.mjs";

const now = "2026-10-12T12:00:00.000Z",
  next = "2026-10-14T12:00:00.000Z";
const main = "a".repeat(40),
  bot = "b".repeat(40),
  human = "c".repeat(40);
const branch = "automation/agent-runtime/codex/012345abcdef";
const pins = { claude: "1.0.0", codex: "1.0.0", cursor: "1.0.0" };
const observations = (version = "1.1.0") =>
  Object.keys(pins).map((provider) => ({
    schema: 1,
    id: `${provider}-registry`,
    provider,
    kind: "registry",
    observedAt: now,
    status: "complete",
    data: {
      pin: "1.0.0",
      latest: provider === "codex" ? version : "1.0.0",
      candidate: provider === "codex" ? version : "1.0.0",
      versions: [],
      installable: true,
    },
  }));
const manifest = (codex: string) =>
  JSON.stringify({
    dependencies: {
      "@openai/codex": codex,
      "@anthropic-ai/claude-agent-sdk": "1.0.0",
      "@cursor/sdk": "1.0.0",
    },
  });
// The shape GitHub returned for the App's first hosted commit (#714): GitHub
// signs API commits as web-flow, and the App is the author.
const commit = (sha = bot, verified = true) => ({
  sha,
  parents: [{ sha: main }],
  author: { type: "Bot", login: "runtime-updater[bot]" },
  committer: { type: "User", login: "web-flow" },
  commit: {
    message: `Zeros-Runtime-Task: ${"d".repeat(64)}\nZeros-Runtime-Provider: codex`,
    verification: { verified, reason: verified ? "valid" : "unsigned" },
    author: {
      name: "runtime-updater[bot]",
      email: "1+runtime-updater[bot]@users.noreply.github.com",
      date: now,
    },
    committer: { name: "GitHub", email: "noreply@github.com", date: now },
  },
});
function fixture() {
  let pr: any = {
    number: 42,
    state: "open",
    created_at: now,
    base: { ref: "main" },
    head: { sha: human, ref: branch, repo: { full_name: "Withso/zeros" } },
    user: { type: "Bot", login: "runtime-updater[bot]" },
    body: proposalMarker("codex", branch),
    labels: [],
  };
  let commits: any[] = [
    commit(),
    {
      sha: human,
      commit: { message: "maintainer implementation" },
      author: { type: "User", login: "maintainer" },
      committer: { type: "User", login: "maintainer" },
    },
  ];
  let version = "1.1.0",
    legacy = false;
  const github = {
    async pages(path: string) {
      if (path.endsWith("/commits")) return commits;
      return legacy
        ? [
            {
              ...pr,
              body: "Renovate upgrade",
              head: { ...pr.head, ref: "renovate/agent-clis" },
              labels: [{ name: "agent-pin" }],
            },
          ]
        : pr.state === "open"
          ? [pr]
          : [];
    },
    async get(path: string) {
      if (path.startsWith("/pulls/")) return pr;
      const e: any = new Error("missing");
      e.status = 404;
      throw e;
    },
    async mergeState() {
      return { auto_merge: null, mergeQueueEntry: null };
    },
    async file() {
      return manifest(version);
    },
  };
  let input = reduceObservations(initialState(now), observations(), now, {
    bootstrap: true,
  });
  input.proposals.codex = {
    pr: 42,
    branch,
    head: bot,
    lastBotCommit: bot,
    lastAppliedAt: now,
    version,
    status: "awaiting-integration",
  };
  const run = (overrides: any = {}) =>
    reconcileProposals({
      github,
      input,
      observations: observations("1.2.0"),
      pins,
      main,
      automation: main,
      now: next,
      appSlug: "runtime-updater",
      createTasks: true,
      ...overrides,
    });
  return {
    github,
    run,
    input,
    pr,
    setVersion: (v: string) => {
      version = v;
    },
    setCommits: (v: any[]) => {
      commits = v;
    },
    legacy: () => {
      legacy = true;
    },
  };
}

describe("same-PR orchestration", () => {
  it("reminds after 48 hours, then weekly, and resets on human integration progress", async () => {
    const f = fixture();
    const integration = {
      sha: human,
      committer: { type: "User" },
      commit: { message: "integration", committer: { date: now } },
    };
    f.setCommits([commit(), integration]);
    const first = await f.run({ createTasks: false });
    const reminders = (state: any) =>
      Object.values<any>(state.events).filter(
        (event) => event.kind === "review-age",
      );
    expect(reminders(first.state)).toHaveLength(1);
    const repeated = await f.run({
      input: first.state,
      createTasks: false,
      now: "2026-10-15T12:00:00.000Z",
    });
    expect(reminders(repeated.state)).toHaveLength(1);
    const compacted = structuredClone(repeated.state);
    compacted.events = {};
    const afterCompaction = await f.run({
      input: compacted,
      createTasks: false,
      now: "2026-10-16T12:00:00.000Z",
    });
    expect(reminders(afterCompaction.state)).toHaveLength(0);
    const week = await f.run({
      input: repeated.state,
      createTasks: false,
      now: "2026-10-19T12:00:00.000Z",
    });
    expect(reminders(week.state)).toHaveLength(2);
    integration.sha = "f".repeat(40);
    integration.commit.committer.date = "2026-10-19T12:00:00.000Z";
    f.pr.head.sha = integration.sha;
    const progress = await f.run({
      input: week.state,
      createTasks: false,
      now: "2026-10-20T12:00:00.000Z",
    });
    expect(reminders(progress.state)).toHaveLength(2);
  });
  it("advances from the current human head and recovers an unsaved signed bot baseline", async () => {
    const f = fixture();
    delete f.input.proposals.codex.lastBotCommit;
    const result = await f.run();
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      provider: "codex",
      pr: 42,
      branch,
      head: human,
      lastBotCommit: bot,
      from: "1.1.0",
      version: "1.2.0",
    });
    const written = finalizeResults(
      result.state,
      result.tasks,
      [
        {
          taskId: result.tasks[0].id,
          status: "written",
          pr: 42,
          head: "e".repeat(40),
        },
      ],
      next,
      "https://github.com/Withso/zeros/actions/runs/1",
    );
    expect(written.proposals.codex).toMatchObject({
      pr: 42,
      branch,
      version: "1.2.0",
      lastBotCommit: "e".repeat(40),
      pendingTask: null,
    });
  });
  it("holds new releases, refreshes the frozen head after human pushes, then resumes on the same PR", async () => {
    const f = fixture();
    f.pr.labels = [{ name: "agent-runtime:hold" }];
    const held = await f.run();
    expect(held.tasks).toHaveLength(0);
    expect(held.state.proposals.codex).toMatchObject({
      status: "held",
      frozenHead: human,
      queued: "1.2.0",
    });
    f.pr.head.sha = "f".repeat(40);
    const advanced = await f.run({ input: held.state });
    expect(advanced.state.proposals.codex.frozenHead).toBe(f.pr.head.sha);
    f.pr.labels = [];
    const resumed = await f.run({ input: advanced.state });
    expect(resumed.tasks[0]).toMatchObject({
      pr: 42,
      branch,
      head: f.pr.head.sha,
    });
  });
  it("starts the next proposal from what actually merged", async () => {
    const f = fixture();
    f.pr.state = "closed";
    f.pr.merged_at = next;
    f.pr.merge_commit_sha = "f".repeat(40);
    const result = await f.run({
      pins: { ...pins, codex: "1.1.0" },
      main: f.pr.merge_commit_sha,
    });
    expect(result.tasks[0]).toMatchObject({
      pr: null,
      head: f.pr.merge_commit_sha,
      from: "1.1.0",
      version: "1.2.0",
    });
    expect(result.tasks[0].branch).not.toBe(branch);
    expect(result.state.proposals.codex.mergedCommit).toBe(
      f.pr.merge_commit_sha,
    );
  });
  it("reads an unpolled maintainer pin at the immutable closed PR head before declining", async () => {
    const f = fixture();
    f.pr.state = "closed";
    f.pr.merged_at = null;
    f.setVersion("1.2.0");
    const read = vi.spyOn(f.github, "file");
    const result = await f.run();
    expect(read).toHaveBeenCalledWith("package.json", human);
    expect(result.tasks).toHaveLength(0);
    expect(result.state.proposals.codex).toMatchObject({
      status: "declined",
      declined: "1.2.0",
      pr: null,
    });
    const newer = await f.run({
      input: result.state,
      observations: observations("1.3.0"),
    });
    expect(newer.tasks).toHaveLength(1);
    expect(newer.tasks[0]).toMatchObject({
      pr: null,
      head: main,
      from: "1.0.0",
      version: "1.3.0",
    });
  });
  it("keeps a closed proposal blocked when its head pin cannot be verified", async () => {
    for (const unavailable of [true, false]) {
      const f = fixture();
      f.pr.state = "closed";
      f.pr.merged_at = null;
      if (unavailable)
        f.github.file = async () => {
          throw new Error("head unavailable");
        };
      else f.setVersion("not-an-exact-pin");
      const result = await f.run();
      expect(result.tasks).toHaveLength(0);
      expect(result.state.proposals.codex).toMatchObject({
        pr: 42,
        status: "reconciliation-blocked",
        version: "1.1.0",
      });
      expect(result.state.proposals.codex.declined).toBeUndefined();
    }
  });
  it("blocks competing Renovate proposals without adopting or closing their branches", async () => {
    const f = fixture();
    f.legacy();
    const result = await f.run();
    expect(result.tasks).toHaveLength(0);
    expect(result.state.proposals.codex.status).toBe("legacy-proposal-open");
  });
  it("cannot recover ownership from a human-copied or unsigned task marker", async () => {
    expect(
      recoverBaseline([commit(bot, false)], "codex", "runtime-updater", {}),
    ).toEqual({ lastBotCommit: null });
    const f = fixture();
    delete f.input.proposals.codex.lastBotCommit;
    f.setCommits([commit(bot, false)]);
    const result = await f.run();
    expect(result.tasks).toHaveLength(0);
    expect(result.state.proposals.codex.status).toBe("baseline-unavailable");
  });
  it("does not spend preparation retries while notifications are only enabled", async () => {
    const f = fixture();
    const result = await f.run({ createTasks: false });
    expect(result.tasks).toHaveLength(0);
    expect(result.state.proposals.codex.lastAttempt).toBeNull();
  });
  it("keeps the preparation blocker visible on the same head after finalization", async () => {
    const f = fixture();
    const pending = await f.run();
    const task = pending.tasks[0];
    const results = await confirmWrittenResults(
      f.github,
      [task],
      [{ taskId: task.id, status: "preparation-blocked" }],
      "runtime-updater",
    );
    expect(results).toEqual([
      { taskId: task.id, provider: "codex", status: "preparation-blocked" },
    ]);
    const finalized = finalizeResults(
      pending.state,
      [task],
      results,
      next,
      "https://github.com/Withso/zeros/actions/runs/1",
    );
    const refreshed = await f.run({ input: finalized, createTasks: false });
    expect(refreshed.tasks).toHaveLength(0);
    expect(refreshed.state.proposals.codex.status).toBe("preparation-blocked");
    expect(refreshed.state.proposals.codex.pr).toBe(42);
  });
  it("requires a signed task commit even when an artifact claims the write succeeded", async () => {
    const f = fixture();
    const task = (await f.run()).tasks[0];
    const claimed = [{ taskId: task.id, status: "written", pr: 42, head: bot }];
    const rejected = await confirmWrittenResults(
      f.github,
      [task],
      claimed,
      "runtime-updater",
    );
    expect(rejected.every((result: any) => result.status !== "written")).toBe(
      true,
    );
    const signed = commit("e".repeat(40));
    signed.parents = [{ sha: task.head }];
    signed.commit.message = `Zeros-Runtime-Task: ${task.id}\nZeros-Runtime-Provider: codex`;
    f.setCommits([signed]);
    f.setVersion(task.version);
    const recovered = await confirmWrittenResults(
      f.github,
      [task],
      [],
      "runtime-updater",
    );
    expect(recovered).toEqual([
      {
        taskId: task.id,
        provider: "codex",
        status: "written",
        pr: 42,
        head: signed.sha,
      },
    ]);
  });
  it("finalizes and recovers unchanged regeneration only from its signed App acknowledgment", async () => {
    const f = fixture();
    f.pr.labels = [{ name: "agent-runtime:regenerate" }];
    f.setVersion("1.2.0");
    const planned = await f.run();
    const task = planned.tasks[0];
    expect(task).toMatchObject({
      regenerate: true,
      from: "1.2.0",
      version: "1.2.0",
      head: human,
      lastBotCommit: human,
    });
    const acknowledgment = commit("e".repeat(40));
    acknowledgment.parents = [{ sha: task.head }];
    acknowledgment.commit.message = `Zeros-Runtime-Task: ${task.id}\nZeros-Runtime-Provider: codex`;
    for (const untrusted of [
      // Pushed with a copied App author identity.
      { ...acknowledgment, committer: { type: "User", login: "maintainer" } },
      // Edited in GitHub's web UI: signed by web-flow, authored by a human.
      { ...acknowledgment, author: { type: "User", login: "maintainer" } },
      {
        ...acknowledgment,
        commit: { ...acknowledgment.commit, verification: { verified: false } },
      },
    ]) {
      f.setCommits([untrusted]);
      const results = await confirmWrittenResults(
        f.github,
        [task],
        [{ taskId: task.id, status: "written", head: human, pr: 42 }],
        "runtime-updater",
      );
      expect(results[0].status).not.toBe("written");
      expect(
        recoverBaseline([untrusted], "codex", "runtime-updater", {})
          .lastBotCommit,
      ).toBeNull();
    }
    f.setCommits([acknowledgment]);
    // The commit succeeded and its label was consumed, but the result artifact was lost.
    f.pr.head.sha = acknowledgment.sha;
    f.pr.labels = [];
    const confirmed = await confirmWrittenResults(
      f.github,
      [task],
      [],
      "runtime-updater",
    );
    expect(confirmed[0]).toMatchObject({
      status: "written",
      head: acknowledgment.sha,
    });
    const finalized = finalizeResults(
      planned.state,
      [task],
      confirmed,
      next,
      "https://github.com/Withso/zeros/actions/runs/1",
    );
    expect(finalized.proposals.codex).toMatchObject({
      lastBotCommit: acknowledgment.sha,
      pendingTask: null,
      lastAttempt: null,
      status: "awaiting-integration",
    });
    expect(
      recoverBaseline([acknowledgment], "codex", "runtime-updater", {})
        .lastBotCommit,
    ).toBe(acknowledgment.sha);
    expect((await f.run({ input: finalized })).tasks).toEqual([]);
  });
  it("binds preparation to task, run, attempt and automation source", async () => {
    const task = (await fixture().run()).tasks[0],
      run = { id: 5, attempt: 2 };
    const result = { status: "blocked" },
      envelope = preparedEnvelope(task, result, run);
    expect(validatePrepared(envelope, task, run)).toEqual(result);
    for (const change of [
      { attempt: 1 },
      { automation: human },
      { taskId: hash("other") },
      { result: { status: "prepared" } },
    ])
      expect(() =>
        validatePrepared({ ...envelope, ...change }, task, run),
      ).toThrow();
  });
  it("refuses publishing from local commands, forks and PR workflow contexts", () => {
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "Withso/zeros",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: main,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
    };
    expect(workflowContext(env).id).toBe(1);
    for (const patch of [
      { GITHUB_ACTIONS: "false" },
      { GITHUB_REF: "refs/pull/42/merge" },
      { GITHUB_REPOSITORY: "fork/zeros" },
    ])
      expect(() => workflowContext({ ...env, ...patch })).toThrow();
  });
});

describe("GitHub-signed App commit identity", () => {
  it("confirms the write, recovers the baseline and keeps the review clock at creation", async () => {
    const f = fixture();
    delete f.input.proposals.codex.lastBotCommit;
    // The unsaved baseline must be recovered from the hosted App commit.
    const planned = await f.run();
    expect(planned.state.proposals.codex.status).not.toBe(
      "baseline-unavailable",
    );
    expect(planned.tasks).toHaveLength(1);
    const task = planned.tasks[0];
    const hosted = commit("e".repeat(40));
    hosted.parents = [{ sha: task.head }];
    hosted.commit.message = `Update Codex runtime to ${task.version}\n\nZeros-Runtime-Task: ${task.id}\nZeros-Runtime-Provider: codex`;
    f.setCommits([hosted]);
    f.setVersion(task.version);
    f.pr.head.sha = hosted.sha;
    const [confirmed] = await confirmWrittenResults(
      f.github,
      [task],
      [],
      "runtime-updater",
    );
    expect(confirmed).toMatchObject({
      status: "written",
      pr: 42,
      head: hosted.sha,
    });
    expect(
      recoverBaseline([hosted], "codex", "runtime-updater", {}).lastBotCommit,
    ).toBe(hosted.sha);
    const reconciled = await f.run({ createTasks: false });
    expect(reconciled.state.proposals.codex.reviewProgress).toBe("42:creation");
  });
  it("never treats another author or GitHub App as the runtime updater", () => {
    for (const author of [
      { type: "User", login: "maintainer" },
      { type: "Bot", login: "other-app[bot]" },
      undefined,
    ])
      expect(
        recoverBaseline(
          [{ ...commit(), author }],
          "codex",
          "runtime-updater",
          {},
        ).lastBotCommit,
      ).toBeNull();
  });
});

describe("PR report refresh diagnostics", () => {
  it("keeps GitHub's numeric status when a report comment is refused", async () => {
    const pr = {
      number: 42,
      state: "open",
      head: { sha: human, repo: { full_name: "Withso/zeros" } },
    };
    const github = {
      async get() {
        return pr;
      },
      async pages() {
        return [];
      },
      async post() {
        const error: any = new Error("GitHub POST failed (HTTP 403).");
        error.status = 403;
        throw error;
      },
    };
    const state = {
      ...initialState(now),
      proposals: {
        codex: {
          pr: 42,
          head: human,
          version: "1.1.0",
          status: "awaiting-integration",
        },
      },
    };
    await expect(
      refreshPrReports(github, state, { trackingIssue: 7 }),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("could not be refreshed"),
    });
  });
});
