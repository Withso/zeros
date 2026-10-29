import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { compareCorpusBaseline, loadCorpus, runCorpus, runCli, splitCorpus, summarizeCases } from "../zstack/eval-corpus.mjs";
import { privateFixtureRoot } from "./zstack-fixtures";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = "a".repeat(40), parent = "b".repeat(40);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const entry = (id: string) => ({ id, kind: "replay", fixedBy: sha, area: "zstack", symptom: "fixture", rule: "fixture",
  check: "pnpm test:git scripts/__tests__/zstack.test.ts" });
const input = (id: string) => ({ id, kind: "replay", fixedBy: sha, checkSha256: hash(entry(id).check), mutationSha256: null });
const result = (id: string, status = "caught") => ({ ...input(id), status,
  code: status === "caught" ? "regression_detected" : status === "missed" ? "parent_passed" : "zstack_revision_unavailable",
  fixed: status === "unverified" ? null : sha, parent: status === "unverified" ? null : parent });
const baseline = (cases: ReturnType<typeof result>[]) => ({ schema: "zeros.zstack-eval-baseline/v1", cases, summary: summarizeCases(cases) });
const observed = (cases: ReturnType<typeof result>[]) => ({ schema: "zeros.zstack-corpus-receipt/v1", complete: true,
  planned: cases.map(row => row.id), cases, summary: summarizeCases(cases) });
const collection = (ids: string[]) => ({ value: { schema: "zeros.zstack-evals/v1", cases: ids.map(entry) }, inputs: ids.map(input) });

describe("corpus regression gate", () => {
  it("partitions a deterministic whole corpus without dropping the 33rd case", () => {
    const ids = Array.from({ length: 65 }, (_, n) => `case-${String(n).padStart(2, "0")}`);
    const batches = splitCorpus(ids.toReversed().map(entry));
    expect(batches.map(batch => batch.length)).toEqual([32, 32, 1]);
    expect(batches.flat().map(row => row.id)).toEqual(ids);
  });
  it.each([0, 33, -1, 1.5, NaN])("refuses an invalid batch bound %s", size => {
    expect(() => splitCorpus([entry("one")], size)).toThrow("zstack_corpus_invalid");
  });
  it("refuses empty or duplicate input identities", () => {
    expect(() => splitCorpus([])).toThrow("zstack_corpus_invalid");
    expect(() => splitCorpus([entry("one"), entry("one")])).toThrow("zstack_corpus_invalid");
  });
  it("keeps misses and unverified cases in the denominator", () => {
    const rows = [result("catch"), result("miss", "missed"), result("unknown", "unverified")];
    expect(summarizeCases(rows)).toMatchObject({ selected: 3, executed: 3, caught: 1, missed: 1, unverified: 1, notRun: 0, catchRate: 1 / 3 });
    expect(compareCorpusBaseline(baseline(rows), observed(rows))).toMatchObject({ allowed: true, caughtDelta: 0, rateDelta: 0 });
  });
  it("refuses a lost catch even when a new catch keeps the total rate unchanged", () => {
    const before = [result("first"), result("second", "missed")];
    const after = [result("first", "missed"), result("second")];
    expect(compareCorpusBaseline(baseline(before), observed(after))).toMatchObject({ allowed: false, rateDelta: 0,
      regressions: [{ id: "first", reason: "catch_lost" }] });
  });
  it("refuses dropped cases and additions that lower the catch rate", () => {
    const before = [result("first"), result("second", "unverified")];
    expect(compareCorpusBaseline(baseline(before), observed(before.slice(0, 1)))).toMatchObject({ allowed: false,
      regressions: [{ id: "second", reason: "dropped" }] });
    expect(compareCorpusBaseline(baseline(before), observed([...before, result("third", "unverified")]))).toMatchObject({ allowed: false });
  });
  it("permits a previously unresolved fix to become verified with the same recipe", () => {
    expect(compareCorpusBaseline(baseline([result("one", "unverified")]), observed([result("one")]))).toMatchObject({ allowed: true });
  });
  it.each(["fixedBy", "checkSha256", "kind", "mutationSha256", "fixed", "parent"])("refuses changed %s evidence", field => {
    const before = result("one");
    const value = field === "kind" ? "scenario" : field === "checkSha256" || field === "mutationSha256" ? "d".repeat(64) : "d".repeat(40);
    expect(compareCorpusBaseline(baseline([before]), observed([{ ...before, [field]: value }]))).toMatchObject({ allowed: false });
  });
  it("compares seed definitions while allowing the execution revision to advance", () => {
    const before = { ...result("one"), kind: "seeded", mutationSha256: hash("seed"), parent: sha };
    const next = { ...before, fixed: "c".repeat(40), parent: "c".repeat(40) };
    expect(compareCorpusBaseline(baseline([before]), observed([next]))).toMatchObject({ allowed: true });
    expect(compareCorpusBaseline(baseline([before]), observed([{ ...next, mutationSha256: hash("different seed") }]))).toMatchObject({ allowed: false });
  });
  it("refuses duplicate, malformed, incomplete and miscounted receipts", () => {
    const rows = [result("one")], before = baseline(rows), after = observed(rows);
    for (const value of [observed([...rows, ...rows]), { ...after, complete: false }, { ...after, complete: "true" },
      { ...after, complete: 1 }, { ...after, planned: ["one", "lost"] },
      { ...after, summary: { ...after.summary, caught: 200 } }, { ...after, schema: "foreign" },
      observed([{ ...rows[0], status: "success" }])]) {
      expect(compareCorpusBaseline(before, value).allowed).toBe(false);
    }
    expect(compareCorpusBaseline({ ...before, summary: { ...before.summary, caught: 0 } }, after).allowed).toBe(false);
  });
});

describe("corpus receipt orchestration", () => {
  async function fixture(ids = ["first", "second"]) {
    const cwd = await privateFixtureRoot(roots), data = collection(ids);
    const options = { cwd, execute: true, outputDir: path.join(cwd, "run"), revision: sha, baseline: baseline(ids.map(id => result(id))) };
    return { cwd, data, options };
  }
  function replay(rows: ReturnType<typeof result>[], edit = (value: any) => value, exitCode?: number) {
    return vi.fn(async (argv: string[], dependencies: any) => {
      const ids = argv.flatMap((arg, n) => arg === "--case" ? [argv[n + 1]] : []);
      const cases = ids.map(id => rows.find(row => row.id === id));
      const value = edit({ schema: "zeros.zstack-eval-receipt/v1", cases, summary: {
        selected: cases.length, caught: cases.filter(row => row?.status === "caught").length,
        missed: cases.filter(row => row?.status === "missed").length, unverified: cases.filter(row => row?.status === "unverified").length,
      } });
      await dependencies.receipt(argv[argv.indexOf("--receipt") + 1], value);
      return exitCode ?? (value.summary.caught === value.summary.selected ? 0 : 1);
    });
  }
  it("executes every <=32-case batch and accepts valid exit-1 receipts with known gaps", async () => {
    const ids = Array.from({ length: 65 }, (_, n) => `case-${String(n).padStart(2, "0")}`);
    const { cwd, options, data } = await fixture(ids.toReversed());
    const rows = ids.map((id, n) => result(id, n % 2 ? "unverified" : "caught"));
    const runBatch = replay(rows);
    const receipt = await runCorpus({ ...options, baseline: baseline(rows) }, { load: async () => data, runBatch });
    expect(receipt).toMatchObject({ complete: true, status: "passed", code: "ok", summary: { selected: 65, executed: 65, caught: 33, unverified: 32 } });
    expect(runBatch.mock.calls.map(([argv]) => argv.filter(arg => arg === "--case").length)).toEqual([32, 32, 1]);
    expect(receipt.cases.map(row => row.id)).toEqual(ids);
    expect(await readdir(path.join(cwd, "run"))).toEqual(expect.arrayContaining(["plan.json", "batch-001.json", "batch-002.json", "batch-003.json", "progress-003.json", "receipt.json"]));
    const final = JSON.parse(await readFile(path.join(cwd, "run/receipt.json"), "utf8"));
    expect(final).toEqual(receipt);
  });
  it.each(["schema", "duplicate", "extra", "summary", "check", "status", "code"])("fails closed on a %s-corrupt batch with a retained receipt", async fault => {
    const { options, data } = await fixture();
    const runBatch = replay([result("first"), result("second")], value => {
      if (fault === "schema") value.schema = "foreign";
      if (fault === "duplicate") value.cases[1] = value.cases[0];
      if (fault === "extra") value.cases.push(result("foreign"));
      if (fault === "summary") value.summary.caught = 40;
      if (fault === "check") value.cases[0].checkSha256 = hash("different");
      if (fault === "status") value.cases[0].status = "success";
      if (fault === "code") value.cases[0].code = "parent_passed";
      return value;
    });
    expect(await runCorpus(options, { load: async () => data, runBatch })).toMatchObject({ complete: false, status: "failed", code: "zstack_corpus_batch_invalid",
      summary: { selected: 2, executed: 0, notRun: 2 } });
    expect(JSON.parse(await readFile(path.join(options.outputDir, "receipt.json"), "utf8")).status).toBe("failed");
  });
  it("does not trust success or known failure exits without their expected receipt", async () => {
    for (const exit of [0, 1]) {
      const { options, data } = await fixture();
      expect(await runCorpus(options, { load: async () => data, runBatch: async () => exit })).toMatchObject({ status: "failed", code: "zstack_corpus_receipt_missing" });
    }
  });
  it("refuses an inconsistent exit code even when a batch receipt looks green", async () => {
    const { options, data } = await fixture();
    expect(await runCorpus(options, { load: async () => data, runBatch: replay([result("first"), result("second")], v => v, 1) }))
      .toMatchObject({ status: "failed", code: "zstack_corpus_batch_invalid" });
  });
  it("keeps completed batches and every outstanding identity on cancellation", async () => {
    const ids = Array.from({ length: 33 }, (_, n) => `case-${String(n).padStart(2, "0")}`);
    const { options, data } = await fixture(ids), controller = new AbortController();
    const execute = replay(ids.map(id => result(id)));
    const runBatch = vi.fn(async (...args: Parameters<typeof execute>) => {
      const code = await execute(...args); controller.abort(); return code;
    });
    const receipt = await runCorpus(options, { load: async () => data, runBatch, signal: controller.signal });
    expect(receipt).toMatchObject({ complete: false, status: "failed", code: "cancelled", summary: { selected: 33, executed: 32, notRun: 1 }, remaining: ["case-32"] });
    expect(runBatch).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(path.join(options.outputDir, "progress-001.json"), "utf8")).remaining).toEqual(["case-32"]);
  });
  it("writes a failure receipt without exposing a thrown child error", async () => {
    const { options, data } = await fixture();
    const receipt = await runCorpus(options, { load: async () => data, runBatch: async () => { throw new Error("private child detail"); } });
    expect(receipt).toMatchObject({ status: "failed", code: "zstack_corpus_failed", complete: false });
    expect(JSON.stringify(receipt)).not.toContain("private child detail");
  });
  it("invalidates evidence when case recipes change during execution", async () => {
    const { options, data } = await fixture();
    const changed = structuredClone(data); changed.inputs[0].checkSha256 = hash("changed");
    const load = vi.fn().mockResolvedValueOnce(data).mockResolvedValue(changed);
    expect(await runCorpus(options, { load, runBatch: replay([result("first"), result("second")]) }))
      .toMatchObject({ complete: false, status: "failed", code: "source_changed" });
  });
  it("invalidates evidence when the runner changes during execution", async () => {
    const { options, data } = await fixture();
    const load = vi.fn().mockResolvedValueOnce({ ...data, toolSha256: hash("before") })
      .mockResolvedValue({ ...data, toolSha256: hash("after") });
    expect(await runCorpus(options, { load, runBatch: replay([result("first"), result("second")]) }))
      .toMatchObject({ complete: false, status: "failed", code: "source_changed" });
  });
  it("retains cancellation evidence when the corpus deadline aborts an active batch", async () => {
    const { options, data } = await fixture();
    const runBatch = async (argv: string[], dependencies: any) => {
      if (!dependencies.signal.aborted) await new Promise(resolve => dependencies.signal.addEventListener("abort", resolve, { once: true }));
      const cases = data.inputs.map(row => ({ id: row.id, status: "unverified", code: "cancelled" }));
      await dependencies.receipt(argv[argv.indexOf("--receipt") + 1], { schema: "zeros.zstack-eval-receipt/v1", cases,
        summary: { selected: 2, caught: 0, missed: 0, unverified: 2 } });
      return 1;
    };
    expect(await runCorpus({ ...options, timeoutMs: 1 }, { load: async () => data, runBatch }))
      .toMatchObject({ complete: false, status: "failed", code: "deadline", summary: { executed: 2, unverified: 2 } });
  });
  it.each(["twice", "foreign path"])("refuses a receipt callback used %s", async fault => {
    const { options, data } = await fixture();
    const valid = replay([result("first"), result("second")]);
    const runBatch = async (argv: string[], dependencies: any) => {
      if (fault === "twice") { await valid(argv, dependencies); return valid(argv, dependencies); }
      return valid(argv, { ...dependencies, receipt: (_file: string, value: any) => dependencies.receipt(path.join(options.cwd, "foreign.json"), value) });
    };
    expect(await runCorpus(options, { load: async () => data, runBatch }))
      .toMatchObject({ status: "failed", code: "zstack_corpus_batch_invalid" });
    expect(await readdir(options.cwd)).not.toContain("foreign.json");
  });
  it("never overwrites a prior attempt", async () => {
    const { options, data } = await fixture();
    await mkdir(options.outputDir); await writeFile(path.join(options.outputDir, "receipt.json"), "original evidence");
    await expect(runCorpus(options, { load: async () => data })).rejects.toThrow("zstack_corpus_output_exists");
    expect(await readFile(path.join(options.outputDir, "receipt.json"), "utf8")).toBe("original evidence");
  });
  it("plans without executing or creating evidence directories", async () => {
    const { cwd, options, data } = await fixture(), runBatch = vi.fn();
    const plan = await runCorpus({ ...options, execute: false }, { load: async () => data, runBatch });
    expect(plan).toMatchObject({ schema: "zeros.zstack-corpus-plan/v1", batches: [["first", "second"]], execute: false });
    expect(runBatch).not.toHaveBeenCalled();
    expect(await readdir(cwd)).toEqual([]);
  });
  it("loads recipe identities separately from prose and records absent seed definitions", async () => {
    const cwd = await privateFixtureRoot(roots);
    await mkdir(path.join(cwd, "agents/zstack/evals"), { recursive: true });
    const value = { schema: "zeros.zstack-evals/v1", cases: [{ ...entry("seed"), kind: "seeded" }] };
    await writeFile(path.join(cwd, "agents/zstack/evals/cases.json"), JSON.stringify(value));
    const before = await loadCorpus(cwd);
    value.cases[0].rule = "clearer prose";
    await writeFile(path.join(cwd, "agents/zstack/evals/cases.json"), JSON.stringify(value));
    expect((await loadCorpus(cwd)).inputs).toEqual(before.inputs);
    expect(before.inputs[0].mutationSha256).toBeNull();
  });
  it("rejects invalid CLI bounds without executing and provides offline help", async () => {
    const write = vi.fn();
    expect(await runCli(["--batch-size", "33"], { write })).toBe(1);
    expect(write).toHaveBeenLastCalledWith({ schema: "zeros.zstack-error/v1", code: "zstack_corpus_invalid" });
    expect(await runCli(["--help"], { write })).toBe(0);
    expect(write.mock.calls.at(-1)?.[0].help).toContain("--execute");
  });
  it("keeps the committed observations bound to the current recipes and their recorded source groups", async () => {
    const committed = JSON.parse(await readFile("agents/zstack/evals/baseline.json", "utf8"));
    const { inputs } = await loadCorpus(process.cwd());
    for (const row of committed.cases) {
      expect(inputs.find(input => input.id === row.id)).toEqual({ id: row.id, kind: row.kind, fixedBy: row.fixedBy,
        checkSha256: row.checkSha256, mutationSha256: row.mutationSha256 });
    }
    expect(compareCorpusBaseline(committed, observed(committed.cases))).toMatchObject({ allowed: true });
    for (const key of ["selected", "caught", "missed", "unverified"])
      expect(committed.sources.reduce((total: number, source: any) => total + source.summary[key], 0)).toBe(committed.summary[key]);
    expect(committed.summary).toMatchObject({ selected: 363, caught: 173, missed: 4, unverified: 186 });
  });
});
