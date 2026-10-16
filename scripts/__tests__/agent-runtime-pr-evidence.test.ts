import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  acceptPrEvidence,
  refreshLatestPrEvidence,
} from "../agent-runtime/pr-evidence.mjs";
import { GATES } from "../agent-runtime/qualification.mjs";
import { proposalMarker } from "../agent-runtime/proposals.mjs";
import { initialState } from "../agent-runtime/state.mjs";

function archive(value: unknown) {
  const data = Buffer.from(JSON.stringify(value));
  const compressed = deflateRawSync(data);
  const name = Buffer.from("report.json");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt16LE(8, 10);
  directory.writeUInt32LE(compressed.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, directory, name, end]);
}

function fixture() {
  const head = "a".repeat(40),
    base = "b".repeat(40),
    testedHead = "c".repeat(40);
  const branch = "automation/agent-runtime/codex/012345abcdef";
  const run: any = {
    id: 101,
    run_attempt: 2,
    workflow_id: 10,
    repository: { full_name: "Withso/zeros" },
    head_repository: { full_name: "Withso/zeros" },
    head_sha: head,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    pull_requests: [{ number: 42, head: { sha: head }, base: { sha: base } }],
  };
  const pr: any = {
    number: 42,
    state: "open",
    head: { sha: head, ref: branch, repo: { full_name: "Withso/zeros" } },
    base: { ref: "main" },
    user: { type: "Bot", login: "runtime-updater[bot]" },
    body: proposalMarker("codex", branch),
  };
  const report: any = {
    schema: 1,
    repository: "Withso/zeros",
    runId: run.id,
    attempt: run.run_attempt,
    event: run.event,
    pr: pr.number,
    head,
    base,
    testedHead,
    changes: [],
    gates: GATES.map((name: string) => ({
      name,
      status: "passed",
      exitCode: 0,
    })),
  };
  const commit = { sha: testedHead, parents: [{ sha: base }, { sha: head }] };
  const job: any = {
    name: "runtime-qualification / agent-runtime-qualification",
    run_attempt: 2,
    conclusion: "success",
    steps: [
      { name: "Save runtime qualification report", conclusion: "success" },
    ],
  };
  const artifact: any = {
    id: 123,
    name: "agent-runtime-qualification-101-2",
    expired: false,
    size_in_bytes: 1000,
    workflow_run: { id: run.id, head_sha: head },
  };
  const artifacts = [artifact],
    calls: string[] = [];
  const github = {
    prefix: "/repos/Withso/zeros",
    async get(path: string) {
      calls.push(path);
      if (path === "/actions/runs/101") return run;
      if (path === "/actions/workflows/ci.yml") return { id: 10 };
      if (path === "/pulls/42") return pr;
      if (path === `/git/commits/${testedHead}`) return commit;
      if (path.includes("/artifacts?")) return { artifacts };
      if (path.includes("/jobs?")) return { jobs: [job] };
      if (path.startsWith("/actions/workflows/ci.yml/runs?"))
        return { workflow_runs: [run] };
      throw new Error(`Unexpected fixture request: ${path}`);
    },
    async fetch() {
      return new Response(archive(report));
    },
    async file() {
      return JSON.stringify({
        dependencies: {
          "@openai/codex": "1.1.0",
          "@anthropic-ai/claude-agent-sdk": "1.0.0",
          "@cursor/sdk": "1.0.0",
        },
      });
    },
  };
  const state = initialState("2026-10-12T12:00:00.000Z");
  state.proposals.codex = {
    pr: 42,
    branch,
    head,
    status: "awaiting-integration",
  };
  const accept = () =>
    acceptPrEvidence(github, state, {
      id: 101,
      attempt: 2,
      appSlug: "runtime-updater",
    });
  return {
    run,
    pr,
    report,
    commit,
    job,
    artifact,
    artifacts,
    state,
    calls,
    github,
    accept,
  };
}

describe("trusted PR evidence publication", () => {
  it("binds real artifact evidence to the current source and tested merge parents", async () => {
    const f = fixture();
    const result = await f.accept();
    expect(result.status).toBe("accepted");
    expect(result.state.proposals.codex.report).toMatchObject({
      head: f.pr.head.sha,
      testedHead: f.commit.sha,
      version: "1.1.0",
      runId: 101,
      attempt: 2,
    });
    expect(
      result.state.proposals.codex.report.gates.every(
        (gate: any) => gate.status === "passed",
      ),
    ).toBe(true);
  });

  it.each([
    "absent",
    "expired",
    "wrong-run",
    "wrong-attempt",
    "wrong-merge",
    "missing-gate",
    "no-producer",
    "failed-producer",
  ])("marks %s evidence incomplete instead of green", async (failure) => {
    const f = fixture();
    if (failure === "absent") f.artifacts.length = 0;
    if (failure === "expired") f.artifact.expired = true;
    if (failure === "wrong-run") f.artifact.workflow_run.id = 100;
    if (failure === "wrong-attempt") f.report.attempt = 1;
    if (failure === "wrong-merge") f.commit.parents[1].sha = "d".repeat(40);
    if (failure === "missing-gate") f.report.gates.pop();
    if (failure === "no-producer") f.job.steps[0].conclusion = "skipped";
    if (failure === "failed-producer") f.job.conclusion = "failure";
    const result = await f.accept();
    expect(result.status).toBe("accepted");
    expect(result.state.proposals.codex.report.testedHead).toBeNull();
    expect(result.state.proposals.codex.report.gates).toHaveLength(
      GATES.length,
    );
    expect(
      result.state.proposals.codex.report.gates.every(
        (gate: any) => gate.status === "incomplete",
      ),
    ).toBe(true);
  });

  it("retains a failing gate even when other runtime checks passed", async () => {
    const f = fixture();
    f.report.gates[0] = { name: GATES[0], status: "failed", exitCode: 1 };
    f.job.conclusion = "failure";
    f.run.conclusion = "failure";
    const result = await f.accept();
    expect(result.state.proposals.codex.report.gates[0].status).toBe("failed");
    expect(result.state.proposals.codex.report.gates[1].status).toBe("passed");
  });

  it.each(["stale", "cancelled", "unmanaged", "superseded"])(
    "does not replace the report with %s evidence",
    async (status) => {
      const f = fixture();
      if (status === "stale") f.pr.head.sha = "d".repeat(40);
      if (status === "cancelled") f.run.conclusion = "cancelled";
      if (status === "unmanaged") f.pr.user.type = "User";
      if (status === "superseded")
        f.state.proposals.codex.report = {
          head: f.pr.head.sha,
          runId: 102,
          attempt: 1,
        };
      const result = await f.accept();
      expect(result.status).toBe(status);
      expect(result.state).toBe(f.state);
      expect(f.calls.some((path) => path.includes("/artifacts?"))).toBe(false);
    },
  );

  it("rejects fork and different-workflow provenance before artifact access", async () => {
    for (const failure of ["fork", "workflow"]) {
      const f = fixture();
      if (failure === "fork") f.run.head_repository.full_name = "fork/zeros";
      else f.run.workflow_id = 99;
      await expect(f.accept()).rejects.toThrow();
      expect(f.calls.some((path) => path.includes("/artifacts?"))).toBe(false);
    }
  });

  it("recovers a missed workflow_run publication during the next scan", async () => {
    const f = fixture();
    const state = await refreshLatestPrEvidence(
      f.github,
      f.state,
      "runtime-updater",
    );
    expect(state.proposals.codex.report.runId).toBe(101);
    expect(
      state.proposals.codex.report.gates.every(
        (gate: any) => gate.status === "passed",
      ),
    ).toBe(true);
  });
});
