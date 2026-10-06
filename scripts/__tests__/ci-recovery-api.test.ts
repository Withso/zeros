import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowWrite,
  createGitHubApi,
  REPO_API,
  reservationName,
} from "../ci/recovery-api.mjs";
import { parseContractBody } from "../ci/recovery-contract.mjs";
import { guardMarkers, publicSummary } from "../ci/recovery.mjs";
import {
  greenJobs,
  jobFixtures,
  MAIN_SHA,
  NOW,
  recoveryFixture,
  sourceRun,
} from "./fixtures/ci-recovery-api.mjs";

const sourceDecision = async (fixture: ReturnType<typeof recoveryFixture>) =>
  (await fixture.controller().reconcile()).decisions[0];

async function applyNext(
  fixture: ReturnType<typeof recoveryFixture>,
  intent: string,
) {
  const row = await sourceDecision(fixture);
  const controller = fixture.controller(
    intent === "retry" ? "retry" : "incident",
  );
  const reservation = await controller.prepare({
    intent,
    signature: row.signature,
    runId: row.run_id,
    attempt: row.attempt,
  });
  if (!reservation)
    throw new Error("Expected an applicable fixture reservation");
  return controller.apply(reservation, fixture.save(reservation));
}

describe("CI recovery API trust boundaries", () => {
  it("reads repository metadata at GitHub's canonical endpoint without a trailing slash", async () => {
    const fixture = recoveryFixture();
    const metadata = await fixture.controller().metadata();
    expect(metadata.head).toBe(MAIN_SHA);
    expect(fixture.state.requests[0].path).toBe(REPO_API);
  });

  it("executes inspection with GETs only and keeps off/retry modes bounded", async () => {
    const fixture = recoveryFixture({ mode: "off" });
    const state = await fixture.controller().reconcile();
    const summary = publicSummary(state, "off");
    expect(summary.decisions[0].decision).toBe("retry");
    expect(summary.decisions[0].write_allowed).toBe(false);
    expect(
      fixture.state.requests.every((request) => request.method === "GET"),
    ).toBe(true);
    expect(fixture.state.writes).toEqual([]);
    fixture.state.env.ZEROS_CI_RECOVERY = "retry";
    fixture.state.runs.get("123")!.run_attempt = 2;
    const persistent = await sourceDecision(fixture);
    expect(persistent.action).toBe("upsert");
    expect(persistent.writeAllowed).toBe(false);
  });

  it("rejects workflow/ref/repository spoofing and source-selected observers", async () => {
    for (const change of [
      { event: "workflow_dispatch" },
      { head_branch: "release/1.2.3" },
      { head_branch: "ci-fix/example" },
      { path: ".github/workflows/fake.yml" },
      { head_repository: { full_name: "Other/zeros" } },
    ]) {
      const fixture = recoveryFixture();
      Object.assign(fixture.state.runs.get("900")!, change);
      await expect(fixture.controller().reconcile()).rejects.toThrow(
        "Untrusted recovery",
      );
      expect(fixture.state.writes).toEqual([]);
    }
  });

  it("never forwards API response diagnostics or retries an ambiguous write", async () => {
    const api = createGitHubApi({
      token: "fixture-only",
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: "sensitive finding" }), {
          status: 403,
        }),
    });
    await expect(api.get(REPO_API)).rejects.toThrow("returned 403");
    await expect(api.get(REPO_API)).rejects.not.toThrow("sensitive finding");
    const fixture = recoveryFixture();
    fixture.state.rerunError = true;
    await expect(applyNext(fixture, "retry")).rejects.toThrow("returned 502");
    expect((await sourceDecision(fixture)).reason).toBe(
      "retry-outcome-unknown",
    );
    expect(fixture.state.writes).toHaveLength(1);
  });

  it("allows only fixed incident and rerun write endpoints", async () => {
    expect(
      allowWrite(
        "retry",
        "POST",
        REPO_API + "/actions/runs/123/rerun-failed-jobs",
        {},
      ),
    ).toBe(true);
    for (const [method, endpoint, body] of [
      ["PATCH", "/git/refs/heads/main", { sha: MAIN_SHA }],
      ["DELETE", "/git/refs/heads/ci-fix/" + "a".repeat(64), undefined],
      ["POST", "/releases", {}],
      ["POST", "/pulls/1/merge", {}],
      ["POST", "/actions/workflows/preflight.yml/dispatches", { ref: "main" }],
      ["POST", "/git/refs", { ref: "refs/heads/release/1.2.3", sha: MAIN_SHA }],
      ["POST", "/issues/1/labels", { labels: ["release-blocker"] }],
    ] as const) {
      expect(allowWrite("incident", method, REPO_API + endpoint, body)).toBe(
        false,
      );
    }
    await expect(
      createGitHubApi({ token: "fixture" }).post(REPO_API + "/git/refs", {}),
    ).rejects.toThrow("not allowed");
  });
});

describe("CI recovery reconciliation", () => {
  it("retries once, rereads attempt immediately before POST, and never reads PRs in retry", async () => {
    const fixture = recoveryFixture();
    const row = await sourceDecision(fixture);
    fixture.state.requests.length = 0;
    const retry = fixture.controller("retry");
    const reservation = await retry.prepare({
      intent: "retry",
      signature: row.signature,
      runId: "123",
      attempt: 1,
    });
    expect(reservation).not.toBeNull();
    const result = await retry.apply(reservation, fixture.save(reservation));
    expect(result).toMatchObject({ applied: true, action: "retry" });
    const last = fixture.state.requests.slice(-2);
    expect(
      last.map(({ method, path: endpoint }) => [method, endpoint]),
    ).toEqual([
      ["GET", REPO_API + "/actions/runs/123"],
      ["POST", REPO_API + "/actions/runs/123/rerun-failed-jobs"],
    ]);
    expect(
      fixture.state.requests.some(({ path: endpoint }) =>
        /\/pulls|\/issues/.test(endpoint),
      ),
    ).toBe(false);
    expect(
      await retry.prepare({
        intent: "retry",
        signature: row.signature,
        runId: "123",
        attempt: 1,
      }),
    ).toBeNull();
    expect(fixture.state.writes).toHaveLength(1);
  });

  it("does not retry a newer manual attempt or write before a saved reservation", async () => {
    const fixture = recoveryFixture();
    const row = await sourceDecision(fixture);
    const retry = fixture.controller("retry");
    const reservation = await retry.prepare({
      intent: "retry",
      signature: row.signature,
      runId: "123",
      attempt: 1,
    });
    await expect(
      retry.apply(reservation, {
        artifactId: "9999",
        artifactDigest: "sha256:" + "a".repeat(64),
      }),
    ).rejects.toThrow();
    const saved = fixture.save(reservation);
    fixture.state.runs.get("123")!.run_attempt = 2;
    expect(await retry.apply(reservation, saved)).toMatchObject({
      applied: false,
    });
    expect(fixture.state.writes).toEqual([]);
  });

  it("reconciles failed-job reruns with the retained successful jobs from earlier attempts", async () => {
    const fixture = recoveryFixture({
      run: sourceRun({
        run_attempt: 2,
        conclusion: "success",
        head_sha: MAIN_SHA,
      }),
    });
    const retained = greenJobs.map((job) => ({ ...job, run_attempt: 1 }));
    const legacy = retained.find((job) => job.name === "ui-smoke (composer)")!;
    legacy.conclusion = "failure";
    const current = {
      ...legacy,
      id: 999,
      run_attempt: 2,
      conclusion: "success",
    };
    fixture.state.jobs.set("123", [...retained, current]);
    const snapshot = await fixture
      .controller()
      .snapshot("123", fixture.state.workflows.preflight);
    expect(snapshot.roots).toEqual([]);
    expect(
      snapshot.jobs.filter((job) => job.name === "ui-smoke (composer)"),
    ).toHaveLength(1);
    expect(
      snapshot.jobs.find((job) => job.name === "ui-smoke (composer)")
        ?.run_attempt,
    ).toBe(2);
    expect(
      fixture.state.requests.find((request) => request.path.endsWith("/jobs"))
        ?.query,
    ).toContain("filter=all");
  });

  it("creates one App-authored draft from current main with one marker and the compulsory label", async () => {
    const fixture = recoveryFixture({ run: sourceRun({ run_attempt: 2 }) });
    expect(await applyNext(fixture, "upsert")).toMatchObject({
      applied: true,
      action: "upsert",
      pr: 200,
    });
    const pr = fixture.state.pulls[0];
    expect(pr.draft).toBe(true);
    expect(
      parseContractBody(pr.body).controller_evidence.artifact_digest,
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(pr.base.ref).toBe("main");
    expect(pr.labels.map((label) => label.name)).toEqual([
      "ci-failure",
      "autofix",
      "ci:ui-smoke",
    ]);
    const commit = fixture.state.writes.find((request) =>
      request.path.endsWith("/git/commits"),
    )!;
    expect(commit.body.parents).toEqual([MAIN_SHA]);
    expect(commit.body.author.name).toBe("zeros-ci-incident[bot]");
    const tree = fixture.state.writes.find((request) =>
      request.path.endsWith("/git/trees"),
    )!;
    expect(tree.body.tree).toHaveLength(1);
    expect(tree.body.tree[0].path).toMatch(
      /^\.github\/ci-incidents\/[a-f0-9]{64}\.json$/,
    );
    const summary = await sourceDecision(fixture);
    expect(summary.reason).toBe("occurrence-already-recorded");
    expect(fixture.state.pulls).toHaveLength(1);
    expect(
      fixture.state.writes.every(
        (request) => request.authorization === "Bearer fixture-app-token",
      ),
    ).toBe(true);
  });

  it("appends one authenticated snapshot per new occurrence without editing the body or branch", async () => {
    const fixture = recoveryFixture({ run: sourceRun({ run_attempt: 2 }) });
    await applyNext(fixture, "upsert");
    const original = fixture.state.pulls[0].body;
    const originalHead = fixture.state.pulls[0].head.sha;
    fixture.nextController();
    fixture.state.runs.set(
      "124",
      sourceRun({ id: 124, head_sha: "c".repeat(40), run_attempt: 2 }),
    );
    fixture.state.jobs.set("124", [jobFixtures.composer]);
    expect(await applyNext(fixture, "upsert")).toMatchObject({
      applied: true,
      pr: 200,
    });
    const comments = fixture.state.comments.get(200)!;
    expect(comments).toHaveLength(1);
    expect(parseContractBody(comments[0].body).occurrences).toHaveLength(2);
    expect(fixture.state.pulls[0].body).toBe(original);
    expect(fixture.state.pulls[0].head.sha).toBe(originalHead);
    expect((await sourceDecision(fixture)).reason).toBe(
      "occurrence-already-recorded",
    );
  });

  it("requires current green evidence and ancestry, preserves touched PRs and comments on resolution once", async () => {
    const fixture = recoveryFixture({ run: sourceRun({ run_attempt: 2 }) });
    await applyNext(fixture, "upsert");
    fixture.nextController();
    fixture.state.runs.set(
      "200",
      sourceRun({ id: 200, head_sha: MAIN_SHA, conclusion: "success" }),
    );
    fixture.state.jobs.set("200", greenJobs);
    fixture.state.divergent.add("a".repeat(40));
    expect((await sourceDecision(fixture)).action).toBe("none");
    fixture.state.divergent.clear();
    fixture.state.pulls[0].assignees.push({ login: "repair-agent" });
    expect((await sourceDecision(fixture)).action).toBe("none");
    fixture.state.pulls[0].assignees.length = 0;
    expect((await sourceDecision(fixture)).action).toBe("resolve");
    expect(await applyNext(fixture, "resolve")).toMatchObject({
      applied: true,
      action: "resolve",
    });
    expect(fixture.state.comments.get(200)).toHaveLength(1);
    expect(
      parseContractBody(fixture.state.comments.get(200)![0].body).state,
    ).toBe("resolved");
    expect(
      fixture.state.pulls[0].labels.map((label) => label.name),
    ).not.toContain("autofix");
    await sourceDecision(fixture);
    expect(fixture.state.comments.get(200)).toHaveLength(1);
    expect(fixture.state.pulls[0].state).toBe("open");
    expect(fixture.state.refs.size).toBe(1);
  });

  it("rejects old green completions and incomplete failed-lane coverage", async () => {
    const fixture = recoveryFixture({
      jobs: [jobFixtures.database],
      run: sourceRun({ run_attempt: 2 }),
    });
    await applyNext(fixture, "upsert");
    fixture.state.runs.set(
      "200",
      sourceRun({ id: 200, head_sha: "c".repeat(40), conclusion: "success" }),
    );
    fixture.state.jobs.set("200", greenJobs);
    expect((await sourceDecision(fixture)).action).not.toBe("resolve");
    fixture.state.runs.get("200")!.head_sha = MAIN_SHA;
    fixture.state.jobs.set(
      "200",
      greenJobs.filter((job) => !job.name.startsWith("control-plane database")),
    );
    expect((await sourceDecision(fixture)).action).not.toBe("resolve");
    fixture.state.jobs.set("200", greenJobs);
    expect((await sourceDecision(fixture)).action).toBe("resolve");
  });

  it.each([
    ["tests-vitest (1/2)", "Run vitest suite", "tests-vitest (4/4)"],
    [
      "control-plane database (2)",
      "Control-plane tests (migrations + auth/invite contracts)",
      "control-plane database (8)",
    ],
  ])(
    "requires the current final partition when resolving a historical %s failure",
    async (name, step, finalPartition) => {
      const fixture = recoveryFixture({
        jobs: [
          {
            ...jobFixtures.database,
            name,
            steps: [{ number: 8, name: step, conclusion: "failure" }],
          },
        ],
        run: sourceRun({ run_attempt: 2 }),
      });
      await applyNext(fixture, "upsert");
      fixture.state.runs.set(
        "200",
        sourceRun({ id: 200, head_sha: MAIN_SHA, conclusion: "success" }),
      );
      fixture.state.jobs.set(
        "200",
        greenJobs.filter((job) => job.name !== finalPartition),
      );
      expect((await sourceDecision(fixture)).action).not.toBe("resolve");
      fixture.state.jobs.set("200", greenJobs);
      expect((await sourceDecision(fixture)).action).toBe("resolve");
    },
  );

  it("requires every composer shard rather than only its successful aggregate", async () => {
    const fixture = recoveryFixture({ run: sourceRun({ run_attempt: 2 }) });
    await applyNext(fixture, "upsert");
    fixture.state.runs.set(
      "200",
      sourceRun({ id: 200, head_sha: MAIN_SHA, conclusion: "success" }),
    );
    const aggregateJobs = greenJobs.map((job) =>
      job.name === "ui-smoke (composer)"
        ? {
            ...job,
            steps: [
              {
                number: 2,
                name: "Enforce the UI smoke result",
                conclusion: "success",
              },
            ],
          }
        : job,
    );
    for (const count of [0, 1, 2]) {
      fixture.state.jobs.set("200", [
        ...aggregateJobs,
        ...Array.from({ length: count }, (_, index) => ({
          ...jobFixtures.composer,
          id: 301 + index,
          name: "tests-ui-smoke (" + (index + 1) + "/3)",
          conclusion: "success",
          steps: [],
        })),
      ]);
      expect((await sourceDecision(fixture)).action).not.toBe("resolve");
    }
    fixture.state.jobs.get("200")!.push({
      ...jobFixtures.composer,
      id: 303,
      name: "tests-ui-smoke (3/3)",
      conclusion: "success",
      steps: [],
    });
    expect((await sourceDecision(fixture)).action).toBe("resolve");
  });

  it("does not trust a same-named artifact from source CI or a forged App PR", async () => {
    const fixture = recoveryFixture({ run: sourceRun({ run_attempt: 2 }) });
    await applyNext(fixture, "upsert");
    fixture.state.artifacts[0].workflow_run.id = 123;
    expect((await sourceDecision(fixture)).reason).toBe(
      "claimed-touched-or-resolved",
    );
    fixture.state.artifacts[0].workflow_run.id = 900;
    fixture.state.pulls[0].user = { ...fixture.state.bot, id: 999 };
    expect((await sourceDecision(fixture)).reason).toBe(
      "unowned-branch-needs-owner",
    );
    expect(fixture.state.pulls).toHaveLength(1);
  });

  it("reports malformed open incidents even after their source leaves recent history", async () => {
    const fixture = recoveryFixture({ run: sourceRun({ run_attempt: 2 }) });
    await applyNext(fixture, "upsert");
    const pr = fixture.state.pulls[0];
    const signature = parseContractBody(pr.body).signature;
    pr.body = "Malformed contract retained for owner review";
    fixture.state.runs.delete("123");
    const state = await fixture.controller().reconcile();
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      signature,
      action: "none",
      writeAllowed: false,
      incident: { number: pr.number },
    });
  });

  it("verifies the App's numeric bot author even when issue App metadata is null", async () => {
    const fixture = recoveryFixture({ run: sourceRun({ run_attempt: 2 }) });
    await applyNext(fixture, "upsert");
    fixture.state.pulls[0].app = null;
    expect((await sourceDecision(fixture)).reason).toBe(
      "occurrence-already-recorded",
    );
  });

  it("never retries a source older than the authenticated reservation history", async () => {
    const fixture = recoveryFixture({
      run: sourceRun({ created_at: "2026-09-28T00:00:00Z" }),
    });
    const row = await sourceDecision(fixture);
    expect(row.action).toBe("none");
    expect(
      await fixture.controller("retry").prepare({
        intent: "retry",
        signature: row.signature,
        runId: "123",
        attempt: 1,
      }),
    ).toBeNull();
    expect(fixture.state.writes).toEqual([]);
  });

  it("preserves a human-owned collision and never creates a second branch", async () => {
    const fixture = recoveryFixture({ run: sourceRun({ run_attempt: 2 }) });
    const row = await sourceDecision(fixture);
    fixture.state.refs.set("ci-fix/" + row.signature, "c".repeat(40));
    expect((await sourceDecision(fixture)).reason).toBe(
      "retained-ref-needs-owner",
    );
    expect(fixture.state.writes).toEqual([]);
  });

  it("allocates at most three new signatures and counts crash reservations against the UTC daily budget", async () => {
    const fixture = recoveryFixture({ jobs: [jobFixtures.quality] });
    for (const [id, job] of [
      [124, jobFixtures.database],
      [125, jobFixtures.secretScan],
      [126, jobFixtures.setupFailure],
    ] as const) {
      fixture.state.runs.set(String(id), sourceRun({ id, run_attempt: 2 }));
      fixture.state.jobs.set(String(id), [job]);
    }
    const planned = await fixture.controller().reconcile();
    expect(
      planned.decisions.filter((row) => row.action === "upsert"),
    ).toHaveLength(3);
    expect(
      planned.decisions.find((row) => row.reason === "daily-creation-budget"),
    ).toBeDefined();
    for (const hex of ["c", "d", "e"]) {
      fixture.save({
        artifact_name: reservationName({
          intent: "create",
          key: hex.repeat(64),
          payloadHash: "f".repeat(64),
          runId: "900",
          attempt: 1,
        }),
      });
    }
    const reserved = await fixture.controller().reconcile();
    expect(
      reserved.decisions.filter((row) => row.action === "upsert"),
    ).toHaveLength(0);
    expect(fixture.state.writes).toEqual([]);
  });

  it("finishes an interrupted resolution label update without duplicating its comment", async () => {
    const fixture = recoveryFixture({ run: sourceRun({ run_attempt: 2 }) });
    await applyNext(fixture, "upsert");
    fixture.nextController();
    fixture.state.runs.set(
      "200",
      sourceRun({ id: 200, head_sha: MAIN_SHA, conclusion: "success" }),
    );
    fixture.state.jobs.set("200", greenJobs);
    fixture.state.failLabelDelete = true;
    await expect(applyNext(fixture, "resolve")).rejects.toThrow("returned 502");
    fixture.state.failLabelDelete = false;
    fixture.nextController();
    expect((await sourceDecision(fixture)).action).toBe("resolve");
    await applyNext(fixture, "resolve");
    expect(fixture.state.comments.get(200)).toHaveLength(1);
    expect(
      fixture.state.pulls[0].labels.map((label) => label.name),
    ).not.toContain("autofix");
  });
});

describe("incident marker guard", () => {
  it("blocks markers and passes only after their removal", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ci-recovery-guard-"));
    try {
      expect(() => guardMarkers(directory)).not.toThrow();
      mkdirSync(path.join(directory, ".github/ci-incidents"), {
        recursive: true,
      });
      const marker = path.join(
        directory,
        ".github/ci-incidents",
        "a".repeat(64) + ".json",
      );
      writeFileSync(marker, "{}");
      expect(() => guardMarkers(directory)).toThrow(
        "together with the real fix",
      );
      rmSync(marker);
      expect(() => guardMarkers(directory)).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
