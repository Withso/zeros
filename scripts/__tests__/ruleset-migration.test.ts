import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIONS_INTEGRATION_ID,
  createGhClient,
  createPlan,
  FINAL_CONTEXTS,
  LEGACY_CONTEXTS,
  parseArgs,
  RULESET_ID,
  runMigration,
} from "../ci/ruleset-migration.mjs";

const NOW = new Date("2026-10-06T12:00:00Z");
const HEAD = "1".repeat(40);
const HISTORY = "2".repeat(40);
const MERGE = "3".repeat(40);
const FORK = "4".repeat(40);
const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(ROOT, "scripts/ci/ruleset-migration.mjs");
const ENDPOINT = "repos/Withso/zeros";

function liveRuleset(contexts = LEGACY_CONTEXTS, strict = false) {
  return {
    id: RULESET_ID,
    name: "main",
    target: "branch",
    source: "Withso/zeros",
    source_type: "Repository",
    enforcement: "active",
    node_id: "read-only-metadata",
    created_at: "2026-08-05T00:00:00Z",
    current_user_can_bypass: "always",
    conditions: {
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["refs/heads/held"] },
    },
    bypass_actors: [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: 8, actor_type: "Team", bypass_mode: "pull_request" },
    ],
    rules: [
      { type: "deletion" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 2,
          required_review_thread_resolution: true,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: strict,
          do_not_enforce_on_create: false,
          required_status_checks: contexts.map((context) => ({
            context,
            integration_id: ACTIONS_INTEGRATION_ID,
          })),
        },
      },
      { type: "non_fast_forward" },
    ],
  };
}

type Live = ReturnType<typeof liveRuleset>;
const contexts = (ruleset: Live) =>
  ruleset.rules[2].parameters!.required_status_checks!.map(
    (check) => check.context,
  );
const advance = (ruleset: Live, stage: string, phase = "restore") =>
  ({ ...ruleset, ...createPlan(ruleset, stage, phase).payload }) as Live;

let nextJob = 100;
function check(
  name: string,
  sha = HEAD,
  overrides: Record<string, unknown> = {},
) {
  const id = nextJob++;
  return {
    id,
    name,
    head_sha: sha,
    app: { id: ACTIONS_INTEGRATION_ID },
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-05T09:00:00Z",
    completed_at: "2026-10-05T10:00:00Z",
    details_url: `https://github.com/Withso/zeros/actions/runs/${sha === HISTORY ? 10 : 11}/job/${id}`,
    ...overrides,
  };
}

type Check = ReturnType<typeof check>;
type Pull = {
  number: number;
  head: { sha: string };
  base: { ref: string };
  merge_commit_sha: string | null;
};
type Fixture = {
  live?: Live;
  checks?: Check[];
  prs?: Pull[];
  workflowPaths?: Record<number, string>;
  attempts?: Record<number, number>;
  historyHeads?: string[];
  pageSize?: number;
  intercept?: (
    method: string,
    endpoint: string,
    fixture: ReturnType<typeof mockGh>,
  ) => unknown;
};

function mockGh(options: Fixture = {}) {
  const rows = options.checks ?? [
    check("zeros/ci-gate"),
    check("zeros/ci-gate", HISTORY),
  ];
  const fixture = {
    live: structuredClone(options.live ?? liveRuleset()),
    prs: options.prs ?? [
      {
        number: 12,
        head: { sha: HEAD },
        base: { ref: "main" },
        merge_commit_sha: MERGE,
      },
    ],
    rows,
    calls: [] as string[][],
    puts: [] as unknown[],
    rulesetGets: 0,
    prGets: 0,
    client: undefined as ReturnType<typeof createGhClient> | undefined,
  };
  const paginate = (values: unknown[], key?: string) => {
    const pages = [];
    const size = options.pageSize ?? Math.max(values.length, 1);
    for (let offset = 0; offset < Math.max(values.length, 1); offset += size) {
      const page = values.slice(offset, offset + size);
      pages.push(key ? { [key]: page, total_count: values.length } : page);
    }
    return pages;
  };
  fixture.client = createGhClient(
    (file: string, args: string[], execution: { stdio: string[] }) => {
      expect(file).toBe("gh");
      expect(execution.stdio).toEqual(["ignore", "pipe", "pipe"]);
      fixture.calls.push(args);
      const method = args[args.indexOf("--method") + 1];
      const endpoint = args[3];
      if (endpoint === `${ENDPOINT}/rulesets/${RULESET_ID}` && method === "GET")
        fixture.rulesetGets += 1;
      if (endpoint.startsWith(`${ENDPOINT}/pulls?`)) fixture.prGets += 1;
      const intercepted = options.intercept?.(method, endpoint, fixture);
      if (intercepted !== undefined) return JSON.stringify(intercepted);
      if (endpoint === `${ENDPOINT}/rulesets/${RULESET_ID}`) {
        if (method === "PUT") {
          const payload = JSON.parse(
            readFileSync(args[args.indexOf("--input") + 1], "utf8"),
          );
          fixture.puts.push(payload);
          fixture.live = { ...fixture.live, ...payload };
        }
        return JSON.stringify(fixture.live);
      }
      if (endpoint.startsWith(`${ENDPOINT}/pulls?`))
        return JSON.stringify(paginate(fixture.prs));
      if (endpoint.startsWith(`${ENDPOINT}/actions/runs?`)) {
        const day = new URLSearchParams(endpoint.split("?")[1]).get("created");
        const runs =
          day === "2026-10-05..2026-10-05"
            ? (options.historyHeads ?? [HISTORY]).map((head_sha) => ({
                head_sha,
              }))
            : [];
        return JSON.stringify(paginate(runs, "workflow_runs"));
      }
      const sha = /\/commits\/([a-f0-9]{40})\/check-runs\?/.exec(endpoint)?.[1];
      if (sha)
        return JSON.stringify(
          paginate(
            fixture.rows.filter((row) => row.head_sha === sha),
            "check_runs",
          ),
        );
      const jobId = Number(/\/actions\/jobs\/(\d+)$/.exec(endpoint)?.[1]);
      if (jobId) {
        const row = fixture.rows.find(
          (row) => Number(String(row.details_url).split("/").at(-1)) === jobId,
        )!;
        const runId = Number(
          /\/runs\/(\d+)\//.exec(String(row.details_url))?.[1],
        );
        return JSON.stringify({
          id: jobId,
          run_id: runId,
          run_attempt: options.attempts?.[jobId] ?? 1,
          name: row.name,
          check_run_url: `https://api.github.com/${ENDPOINT}/check-runs/${row.id}`,
        });
      }
      const runId = Number(/\/actions\/runs\/(\d+)$/.exec(endpoint)?.[1]);
      if (runId)
        return JSON.stringify({
          id: runId,
          path: options.workflowPaths?.[runId] ?? ".github/workflows/ci.yml",
        });
      throw new Error(`Unexpected mock endpoint ${method} ${endpoint}`);
    },
  );
  return fixture;
}

const directories: string[] = [];
function invoke(args: string[], fixture = mockGh(), cwd?: string) {
  const directory =
    cwd ?? mkdtempSync(path.join(tmpdir(), "ruleset migration "));
  if (!cwd) directories.push(directory);
  const output: string[] = [];
  const exitCode = runMigration(args, {
    gh: fixture.client,
    cwd: directory,
    now: NOW,
    log: (line: string) => output.push(line),
  });
  return { exitCode, output: output.join("\n"), directory, fixture };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ruleset migration stage transitions", () => {
  it("adds ten, then eleven, then retires only the seven legacy requirements", () => {
    const old = liveRuleset();
    const gate = advance(old, "add-gate");
    const dual = advance(gate, "add-secret-scan");
    const final = advance(dual, "finalize");
    expect(contexts(old)).toHaveLength(9);
    expect(contexts(gate)).toEqual([...LEGACY_CONTEXTS, "zeros/ci-gate"]);
    expect(contexts(dual)).toEqual([
      ...LEGACY_CONTEXTS,
      "zeros/ci-gate",
      "secret-scan",
    ]);
    expect(new Set(contexts(final))).toEqual(new Set(FINAL_CONTEXTS));
    expect(contexts(old)).toHaveLength(9);
  });

  it.each([false, true])(
    "preserves unrelated rules, bypass actors, conditions, enforcement and strict=%s",
    (strict) => {
      const live = liveRuleset(LEGACY_CONTEXTS, strict);
      live.enforcement = "evaluate";
      const extra = { context: "owner-extra", integration_id: 42 };
      live.rules[2].parameters!.required_status_checks!.push(extra);
      const dual = advance(advance(live, "add-gate"), "add-secret-scan");
      const { payload, diff } = createPlan(dual, "finalize");
      expect(payload.conditions).toEqual(live.conditions);
      expect(payload.bypass_actors).toEqual(live.bypass_actors);
      expect(payload.enforcement).toBe("evaluate");
      expect(
        payload.rules.filter(
          (rule: { type: string }) => rule.type !== "required_status_checks",
        ),
      ).toEqual(
        live.rules.filter((rule) => rule.type !== "required_status_checks"),
      );
      expect(payload.rules[2].parameters).toEqual({
        ...live.rules[2].parameters,
        required_status_checks: [
          ...live.rules[2].parameters!.required_status_checks!.filter((check) =>
            ["actionlint", "codeql", "owner-extra"].includes(check.context),
          ),
          { context: "zeros/ci-gate", integration_id: ACTIONS_INTEGRATION_ID },
          { context: "secret-scan", integration_id: ACTIONS_INTEGRATION_ID },
        ],
      });
      expect(diff).toEqual([
        {
          op: "replace",
          path: "/rules/2/parameters/required_status_checks",
          value: payload.rules[2].parameters.required_status_checks,
        },
      ]);
      for (const field of [
        "id",
        "source",
        "source_type",
        "node_id",
        "created_at",
        "current_user_can_bypass",
      ])
        expect(payload).not.toHaveProperty(field);
    },
  );

  it("refuses skipped add-before-remove prerequisites and unexpected source bindings", () => {
    expect(() => createPlan(liveRuleset(), "add-secret-scan")).toThrow(
      /Run add-gate first/,
    );
    expect(() =>
      createPlan(advance(liveRuleset(), "add-gate"), "finalize"),
    ).toThrow(/Add both replacements/);
    const wrongSource = liveRuleset();
    wrongSource.rules[2].parameters!.required_status_checks![0].integration_id = 42;
    expect(() => createPlan(wrongSource, "add-gate")).toThrow(
      /Actions integration 15368/,
    );
    expect(() =>
      createPlan(liveRuleset(["actionlint", "codeql"]), "add-gate"),
    ).toThrow(/Restore the nine legacy/);
    expect(() => createPlan(liveRuleset(["quality"]), "rollback")).toThrow(
      /Independent scanners/,
    );
  });

  it("restores old requirements alongside replacements before a separate rollback retirement", () => {
    const final = liveRuleset(FINAL_CONTEXTS);
    expect(() => createPlan(final, "rollback", "retire")).toThrow(
      /restore before retiring/,
    );
    const restored = advance(final, "rollback");
    expect(new Set(contexts(restored))).toEqual(
      new Set([...LEGACY_CONTEXTS, ...FINAL_CONTEXTS]),
    );
    expect(contexts(restored)).toHaveLength(11);
    const retired = advance(restored, "rollback", "retire");
    expect(new Set(contexts(retired))).toEqual(new Set(LEGACY_CONTEXTS));
  });

  it.each([
    ["add-gate", "restore", LEGACY_CONTEXTS],
    ["add-secret-scan", "restore", [...LEGACY_CONTEXTS, "zeros/ci-gate"]],
    [
      "finalize",
      "restore",
      [...LEGACY_CONTEXTS, "zeros/ci-gate", "secret-scan"],
    ],
    ["rollback", "restore", FINAL_CONTEXTS],
    [
      "rollback",
      "retire",
      [...LEGACY_CONTEXTS, "zeros/ci-gate", "secret-scan"],
    ],
  ])("is idempotent for %s (%s)", (stage, phase, names) => {
    const after = advance(
      liveRuleset(names as string[]),
      stage as string,
      phase as string,
    );
    expect(createPlan(after, stage, phase).diff).toEqual([]);
    expect(advance(after, stage as string, phase as string)).toEqual(after);
  });

  it("refuses missing or multiple required-status-check rules without constructing a permissive replacement", () => {
    const absent = liveRuleset();
    absent.rules.splice(2, 1);
    expect(() => createPlan(absent, "add-gate")).toThrow(/exactly one/);
    const duplicated = liveRuleset();
    duplicated.rules.push(structuredClone(duplicated.rules[2]));
    expect(() => createPlan(duplicated, "add-gate")).toThrow(/exactly one/);
  });
});

describe("owner verification with mocked gh JSON", () => {
  it("writes an exact payload and JSON patch from the live ruleset without any write API", () => {
    const result = invoke(["plan", "--stage", "add-gate"]);
    const plan = createPlan(result.fixture.live, "add-gate");
    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(
        readFileSync(
          path.join(result.directory, ".context/ci-rollout/add-gate.json"),
          "utf8",
        ),
      ),
    ).toEqual(plan.payload);
    expect(
      JSON.parse(
        readFileSync(
          path.join(result.directory, ".context/ci-rollout/add-gate.diff.json"),
          "utf8",
        ),
      ),
    ).toEqual(plan.diff);
    expect(
      JSON.parse(
        readFileSync(
          path.join(
            result.directory,
            ".context/ci-rollout/add-gate.before.json",
          ),
          "utf8",
        ),
      ),
    ).toEqual(result.fixture.live);
    expect(result.output).toContain(JSON.stringify(plan.payload, null, 2));
    expect(result.fixture.calls).toHaveLength(1);
    expect(result.fixture.puts).toEqual([]);
  });

  it("accepts recent real success plus green checks on every open source head, including forks and API pagination", () => {
    const fixture = mockGh({
      pageSize: 1,
      prs: [
        {
          number: 12,
          head: { sha: HEAD },
          base: { ref: "main" },
          merge_commit_sha: MERGE,
        },
        {
          number: 13,
          head: { sha: FORK },
          base: { ref: "main" },
          merge_commit_sha: null,
        },
      ],
      checks: [
        check("zeros/ci-gate"),
        check("zeros/ci-gate", FORK),
        check("zeros/ci-gate", HISTORY),
      ],
    });
    const result = invoke(["verify", "--stage", "add-gate"], fixture);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("on 2 open PR heads");
    expect(result.output).toContain("Verification passed");
    expect(fixture.puts).toEqual([]);
    expect(
      fixture.calls
        .filter((args) => args.includes("--paginate"))
        .every((args) => args.includes("--slurp")),
    ).toBe(true);
  });

  it("checks a missing open head even when another PR and a repository run are green", () => {
    const fixture = mockGh({
      prs: [
        {
          number: 12,
          head: { sha: HEAD },
          base: { ref: "main" },
          merge_commit_sha: MERGE,
        },
        {
          number: 13,
          head: { sha: FORK },
          base: { ref: "main" },
          merge_commit_sha: null,
        },
      ],
    });
    const result = invoke(["apply", "--stage", "add-gate", "--yes"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/PR #13 head .*: missing zeros\/ci-gate/);
    expect(fixture.puts).toEqual([]);
  });

  it.each([
    ["expired", { completed_at: "2026-09-29T11:59:59Z" }],
    ["future", { completed_at: "2026-10-07T00:00:00Z" }],
    ["skipped", { conclusion: "skipped" }],
    ["neutral", { conclusion: "neutral" }],
    ["failed", { conclusion: "failure" }],
  ])("refuses %s as the only recent success", (_label, overrides) => {
    const fixture = mockGh({
      prs: [],
      checks: [check("zeros/ci-gate", HISTORY, overrides)],
    });
    const result = invoke(["apply", "--stage", "add-gate", "--yes"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("no recent success in the last 7 days");
    expect(fixture.puts).toEqual([]);
  });

  it("uses a check's completion time, including a recent rerun of an older open head", () => {
    const result = invoke(
      ["verify", "--stage", "add-gate"],
      mockGh({
        historyHeads: [],
        checks: [
          check("zeros/ci-gate", HEAD, { started_at: "2026-09-01T00:00:00Z" }),
        ],
      }),
    );
    expect(result.exitCode).toBe(0);
  });

  it("requires the latest PR check to be green, not an older success on the same head", () => {
    const old = check("zeros/ci-gate");
    const latest = check("zeros/ci-gate", HEAD, {
      status: "in_progress",
      conclusion: null,
      completed_at: null,
    });
    const fixture = mockGh({
      checks: [old, latest, check("zeros/ci-gate", HISTORY)],
      attempts: { [latest.id]: 2 },
    });
    const result = invoke(["apply", "--stage", "add-gate", "--yes"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("in_progress/pending, not green");
    expect(fixture.puts).toEqual([]);
  });

  it("does not accept an identically named check from another integration", () => {
    const fixture = mockGh({
      checks: [
        check("zeros/ci-gate", HEAD, { app: { id: 42 } }),
        check("zeros/ci-gate", HISTORY),
      ],
    });
    const result = invoke(["verify", "--stage", "add-gate"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("unexpected integration 42");
  });

  it("rejects different workflows emitting the same name on a head", () => {
    const duplicate = check("zeros/ci-gate");
    duplicate.details_url = duplicate.details_url.replace(
      "/runs/11/",
      "/runs/12/",
    );
    const fixture = mockGh({
      checks: [check("zeros/ci-gate"), duplicate],
      workflowPaths: { 12: ".github/workflows/shadow.yml" },
    });
    const result = invoke(["apply", "--stage", "add-gate", "--yes"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("produced by two different jobs");
    expect(fixture.puts).toEqual([]);
  });

  it("rejects competing replacement producers even when they report on different repository heads", () => {
    const fixture = mockGh({
      workflowPaths: { 10: ".github/workflows/shadow.yml" },
    });
    const result = invoke(["apply", "--stage", "add-gate", "--yes"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("produced by two different jobs");
    expect(fixture.puts).toEqual([]);
  });

  it("rejects two distinct jobs with the same name within one workflow run attempt", () => {
    const result = invoke(
      ["verify", "--stage", "add-gate"],
      mockGh({ checks: [check("zeros/ci-gate"), check("zeros/ci-gate")] }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("produced by two different jobs");
  });

  it("allows another attempt of the same job and a repeated run of the same workflow", () => {
    const first = check("zeros/ci-gate");
    const retry = check("zeros/ci-gate");
    const repeated = check("zeros/ci-gate");
    repeated.details_url = repeated.details_url.replace(
      "/runs/11/",
      "/runs/12/",
    );
    const result = invoke(
      ["verify", "--stage", "add-gate"],
      mockGh({ checks: [first, retry, repeated], attempts: { [retry.id]: 2 } }),
    );
    expect(result.exitCode).toBe(0);
  });

  it("requires all four retained final names before removing any legacy requirement", () => {
    const dual = advance(advance(liveRuleset(), "add-gate"), "add-secret-scan");
    const fixture = mockGh({
      live: dual,
      checks: FINAL_CONTEXTS.filter((name) => name !== "secret-scan").map(
        (name) => check(name),
      ),
    });
    const result = invoke(["apply", "--stage", "finalize", "--yes"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("missing secret-scan");
    expect(contexts(fixture.live)).toHaveLength(11);
    expect(fixture.puts).toEqual([]);
  });

  it("refuses rollback before the legacy producers report, keeping all final requirements", () => {
    const fixture = mockGh({
      live: liveRuleset(FINAL_CONTEXTS),
      checks: FINAL_CONTEXTS.map((name) => check(name)),
    });
    const result = invoke(["apply", "--stage", "rollback", "--yes"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("missing quality");
    expect(contexts(fixture.live)).toEqual(FINAL_CONTEXTS);
    expect(fixture.puts).toEqual([]);
  });

  it("restores legacy producers before adding old requirements, then retires replacements in a second verified PUT", () => {
    const rows = LEGACY_CONTEXTS.flatMap((name) => [
      check(
        name,
        HEAD,
        name === "ui-smoke (composer)" ? { conclusion: "skipped" } : {},
      ),
      check(name, HISTORY),
    ]);
    const fixture = mockGh({ live: liveRuleset(FINAL_CONTEXTS), checks: rows });
    const restore = invoke(["apply", "--stage", "rollback", "--yes"], fixture);
    expect(restore.exitCode).toBe(0);
    expect(contexts(fixture.live)).toHaveLength(11);
    const retire = invoke(
      ["apply", "--stage", "rollback", "--rollback-phase", "retire", "--yes"],
      fixture,
      restore.directory,
    );
    expect(retire.exitCode).toBe(0);
    expect(new Set(contexts(fixture.live))).toEqual(new Set(LEGACY_CONTEXTS));
    expect(fixture.puts).toHaveLength(2);
  });

  it("never treats the skipped composer placeholder as its recent real workload success", () => {
    const fixture = mockGh({
      live: liveRuleset(FINAL_CONTEXTS),
      checks: LEGACY_CONTEXTS.map((name) =>
        check(
          name,
          HEAD,
          name === "ui-smoke (composer)" ? { conclusion: "skipped" } : {},
        ),
      ),
    });
    const result = invoke(["apply", "--stage", "rollback", "--yes"], fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("ui-smoke (composer): no recent success");
    expect(fixture.puts).toEqual([]);
  });

  it("fails closed on truncated check-run pagination", () => {
    const fixture = mockGh({
      intercept: (_method, endpoint) =>
        endpoint.includes("/check-runs?")
          ? [{ total_count: 101, check_runs: [] }]
          : undefined,
    });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture),
    ).toThrow(/pagination is incomplete/);
    expect(fixture.puts).toEqual([]);
  });

  it("refuses overlapping check-run pages instead of counting repeated checks as complete evidence", () => {
    const fixture = mockGh({
      intercept: (_method, endpoint, fixture) =>
        endpoint.includes(`/commits/${HEAD}/check-runs?`)
          ? [
              { total_count: 2, check_runs: [fixture.rows[0]] },
              { total_count: 2, check_runs: [fixture.rows[0]] },
            ]
          : undefined,
    });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture),
    ).toThrow(/Repeated check run/);
    expect(fixture.puts).toEqual([]);
  });

  it("refuses page totals that change while reading evidence", () => {
    const fixture = mockGh({
      intercept: (_method, endpoint, fixture) =>
        endpoint.includes(`/commits/${HEAD}/check-runs?`)
          ? [
              { total_count: 1, check_runs: [fixture.rows[0]] },
              { total_count: 2, check_runs: [fixture.rows[0]] },
            ]
          : undefined,
    });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture),
    ).toThrow(/pagination is incomplete/);
    expect(fixture.puts).toEqual([]);
  });

  it("fails closed at the Actions filtered-search limit instead of overlooking another producer", () => {
    const fixture = mockGh({
      intercept: (_method, endpoint) =>
        endpoint.includes("/actions/runs?")
          ? [
              {
                total_count: 1000,
                workflow_runs: Array.from({ length: 1000 }, () => ({
                  head_sha: HISTORY,
                })),
              },
            ]
          : undefined,
    });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture),
    ).toThrow(/1,000-run limit/);
    expect(fixture.puts).toEqual([]);
  });
});

describe("apply authorization and race guards", () => {
  it("refuses a write when the live ruleset is not actively protecting the branch", () => {
    const live = liveRuleset();
    live.enforcement = "disabled";
    const fixture = mockGh({ live });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture),
    ).toThrow(/enforcement must be active/);
    expect(fixture.puts).toEqual([]);
  });

  it("defaults apply to a dry run and makes exactly one PUT after same-invocation verification with --yes", () => {
    const fixture = mockGh();
    const dry = invoke(["apply", "--stage", "add-gate"], fixture);
    expect(dry.exitCode).toBe(0);
    expect(dry.output).toContain("Dry run passed");
    expect(fixture.puts).toEqual([]);
    const applied = invoke(
      ["apply", "--stage", "add-gate", "--yes"],
      fixture,
      dry.directory,
    );
    expect(applied.exitCode).toBe(0);
    expect(fixture.puts).toHaveLength(1);
    expect(applied.output).toContain("Live after required checks");
    expect(contexts(fixture.live)).toHaveLength(10);
    const put = fixture.calls.find((args) => args.includes("PUT"))!;
    expect(put[put.indexOf("--input") + 1]).toBe(
      path.join(dry.directory, ".context/ci-rollout/add-gate.json"),
    );
    const noop = invoke(
      ["apply", "--stage", "add-gate", "--yes"],
      fixture,
      dry.directory,
    );
    expect(noop.exitCode).toBe(0);
    expect(noop.output).toContain("no PUT needed");
    expect(fixture.puts).toHaveLength(1);
  });

  it("never reuses a successful previous verify when checks have disappeared", () => {
    const fixture = mockGh();
    expect(invoke(["verify", "--stage", "add-gate"], fixture).exitCode).toBe(0);
    fixture.rows.splice(0);
    expect(
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture).exitCode,
    ).toBe(1);
    expect(fixture.puts).toEqual([]);
  });

  it("refuses a concurrent unrelated ruleset edit", () => {
    const fixture = mockGh({
      intercept: (_method, endpoint, fixture) => {
        if (
          endpoint.endsWith(`/rulesets/${RULESET_ID}`) &&
          fixture.rulesetGets === 2
        )
          return { ...fixture.live, name: "owner edited" };
      },
    });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture),
    ).toThrow(/ruleset changed during verification/);
    expect(fixture.puts).toEqual([]);
  });

  it("refuses a new or updated open PR after verification", () => {
    const fixture = mockGh({
      intercept: (_method, endpoint, fixture) => {
        if (endpoint.includes("/pulls?") && fixture.prGets === 2)
          return [[{ ...fixture.prs[0], head: { sha: FORK } }]];
      },
    });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture),
    ).toThrow(/Open PR heads changed/);
    expect(fixture.puts).toEqual([]);
  });

  it("refuses a check that turns red immediately before PUT", () => {
    const fixture = mockGh({
      intercept: (_method, endpoint, fixture) => {
        if (
          endpoint.includes(`/commits/${HEAD}/check-runs?`) &&
          fixture.prGets === 2
        )
          return [
            {
              total_count: 1,
              check_runs: [{ ...fixture.rows[0], conclusion: "failure" }],
            },
          ];
      },
    });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture),
    ).toThrow(/PR checks changed during verification/);
    expect(fixture.puts).toEqual([]);
  });

  it("refuses an altered local payload instead of submitting it", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ruleset altered "));
    directories.push(directory);
    const fixture = mockGh({
      intercept: (_method, endpoint, fixture) => {
        if (endpoint.includes("/pulls?") && fixture.prGets === 2)
          writeFileSync(
            path.join(directory, ".context/ci-rollout/add-gate.json"),
            JSON.stringify({ enforcement: "disabled" }),
          );
      },
    });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture, directory),
    ).toThrow(/payload file changed/);
    expect(fixture.puts).toEqual([]);
  });

  it("reports a readback mismatch without making another write", () => {
    const fixture = mockGh({
      intercept: (_method, endpoint, fixture) => {
        if (
          endpoint.endsWith(`/rulesets/${RULESET_ID}`) &&
          fixture.rulesetGets === 3
        )
          return { ...fixture.live, bypass_actors: [] };
      },
    });
    expect(() =>
      invoke(["apply", "--stage", "add-gate", "--yes"], fixture),
    ).toThrow(/Live ruleset differs/);
    expect(fixture.puts).toHaveLength(1);
  });

  it("keeps gh authentication diagnostics and credential-bearing stderr out of errors", () => {
    const client = createGhClient(() => {
      throw Object.assign(new Error("sensitive-auth-fixture"), {
        status: 403,
        stderr: "sensitive-auth-fixture",
      });
    });
    expect(() =>
      client.request("GET", `${ENDPOINT}/rulesets/${RULESET_ID}`),
    ).toThrow(/failed \(exit 403\)/);
    expect(() =>
      client.request("GET", `${ENDPOINT}/rulesets/${RULESET_ID}`),
    ).not.toThrow(/sensitive-auth-fixture/);
  });

  it("rejects typos, misplaced confirmations and unknown stages before any API call", () => {
    for (const args of [
      ["apply", "--stage", "add-gate", "--yse"],
      ["plan", "--stage", "add-gate", "--yes"],
      ["apply", "--stage", "add-gate", "--stage", "finalize"],
      ["apply", "--stage"],
      ["apply", "--stage", "add-gate", "--rollback-phase", "retire"],
      ["apply", "--stage", "add-gate; touch marker", "--yes"],
    ]) {
      const fixture = mockGh();
      expect(() => invoke(args, fixture)).toThrow();
      expect(fixture.calls).toEqual([]);
    }
    expect(parseArgs(["apply", "--stage", "rollback"])).toMatchObject({
      yes: false,
      rollbackPhase: "restore",
    });
  });

  it("exposes a dependency-free CLI help path and a nonzero refusal exit", () => {
    const help = spawnSync(process.execPath, [SCRIPT, "--help"], {
      encoding: "utf8",
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Apply is a dry run");
    const refused = spawnSync(
      process.execPath,
      [SCRIPT, "apply", "--stage", "unknown"],
      { encoding: "utf8" },
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Ruleset migration refused");
  });
});
