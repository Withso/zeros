import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, rm, open, mkdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repositoryPath } from "./check-plan.mjs";
import { resolveFix, revisionTree, projectRevision, sourceBytes, linkDependencies } from "./source.mjs";
import { runCommand } from "./runner.mjs";

const fail = () => { throw new Error("zstack_check_unsupported"); };
function words(text) {
  if (typeof text !== "string" || text.length > 8192 || /[\r\n\0;$`|&<>\\]/.test(text)) fail();
  const result = []; let value = "", quote = null;
  for (const char of text) {
    if (quote) { if (char === quote) quote = null; else value += char; }
    else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) { if (value) { result.push(value); value = ""; } }
    else value += char;
  }
  if (quote) fail();
  if (value) result.push(value);
  return result;
}

export function parseReplayCheck(text, files) {
  let argv = words(text), prefix;
  if (argv.slice(0, 6).join(" ") === "pnpm --dir apps/control-plane exec vitest run") prefix = 6;
  else if (argv.slice(0, 4).join(" ") === "pnpm exec vitest run") prefix = 4;
  else if (argv.slice(0, 2).join(" ") === "pnpm test:git") {
    argv = ["pnpm", "exec", "vitest", "run", "--config", "vitest.config.ts", ...argv.slice(2)]; prefix = 4;
  } else fail();
  const tests = [], known = new Set(files), cp = prefix === 6;
  for (let index = prefix; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--config") {
      if (cp || !["vitest.config.ts", "scripts/release/vitest.config.ts"].includes(argv[++index])) fail();
    } else if (arg === "-t" || arg === "--testNamePattern") {
      if (!argv[++index] || argv[index].startsWith("-") || argv[index].length > 512) fail();
    } else {
      const test = cp ? `apps/control-plane/${arg}` : arg;
      if (arg.startsWith("-") || !repositoryPath(test) || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(test) || !known.has(test)) fail();
      tests.push(test);
    }
  }
  if (!tests.length || tests.length > 32) fail();
  return { id: "eval", argv, kind: "vitest", tests };
}

export async function replaceProjectionFile(root, file, bytes) {
  if (!repositoryPath(file)) throw new Error("zstack_path_invalid");
  const target = path.join(root, file), temporary = path.join(path.dirname(target), `.zstack-${randomUUID()}`);
  await mkdir(path.dirname(target), { recursive: true });
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()) throw new Error("zstack_projection_invalid");
    await handle.writeFile(bytes); await handle.sync(); await rename(temporary, target);
  } finally { await handle.close(); await rm(temporary, { force: true }); }
}

export async function prepareReplay(entry, { cwd, scratch = os.tmpdir() }) {
  const revisions = resolveFix(cwd, entry.fixedBy), tree = revisionTree(cwd, revisions.fixed);
  const files = tree.map(row => row.file), command = parseReplayCheck(entry.check, files);
  const root = await mkdtemp(path.join(scratch, "zstack-replay-"));
  const green = path.join(root, "fixed"), red = path.join(root, "parent");
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    await projectRevision(cwd, revisions.fixed, green, tree);
    const parentFiles = await projectRevision(cwd, revisions.parent, red);
    // Keep the regression's assertions identical on both sides. No product
    // helpers or configs are overlaid; missing historical imports stay unknown.
    for (const test of command.tests) {
      const source = await sourceBytes(green, test);
      if (!source || source.mode === 0o120000) throw new Error("zstack_projection_invalid");
      await replaceProjectionFile(red, test, source.bytes);
    }
    await linkDependencies(cwd, green, files); await linkDependencies(cwd, red, parentFiles);
    return { ...revisions, green, red, files, dispose };
  } catch (error) { await dispose(); throw error; }
}

export async function replayCase(entry, { cwd, scratch, prepare = prepareReplay, run = runCommand, signal, timeoutMs = 120_000 } = {}) {
  const startedAt = new Date().toISOString(); let projection, green = null, red = null;
  const result = (status, code) => ({ id: entry.id, kind: entry.kind, status, code, startedAt, completedAt: new Date().toISOString(),
    fixed: projection?.fixed ?? null, parent: projection?.parent ?? null,
    checkSha256: createHash("sha256").update(entry.check).digest("hex"), green, red });
  try {
    if (entry.kind !== "replay") return result("unverified", "explicit_scenario_required");
    projection = await prepare(entry, { cwd, scratch });
    const command = parseReplayCheck(entry.check, projection.files);
    green = await run(command, { cwd: projection.green, signal, timeoutMs });
    if (green.status !== "passed" || green.tests?.passed < 1) return result("unverified", "fixed_failed");
    red = await run(command, { cwd: projection.red, signal, timeoutMs });
    if (red.code === "ok") return result("missed", "parent_passed");
    if (red.code !== "tests_failed") return result("unverified", red.code);
    const passed = new Set(green.tests.identities.filter(test => test.status === "passed").map(test => test.id));
    const failed = red.tests?.identities.filter(test => test.status === "failed");
    if (!failed?.length || failed.some(test => !passed.has(test.id))) return result("unverified", "assertions_changed");
    return result("caught", "regression_detected");
  } catch (error) {
    const code = /^zstack_(?:check_unsupported|revision_unavailable|revision_ambiguous|dependencies_unavailable|git_unavailable|projection_invalid|projection_unsupported|source_limit|source_unsafe|seed_invalid|seed_not_applicable)$/.test(error?.message ?? "")
      ? error.message : "zstack_replay_failed";
    return result("unverified", code);
  } finally { await projection?.dispose(); }
}

export function applySeed(text, seed) {
  if (!seed || Object.keys(seed).sort().join(",") !== "after,before,file" || !repositoryPath(seed.file) ||
    typeof seed.before !== "string" || !seed.before.length || seed.before.length > 16_384 ||
    typeof seed.after !== "string" || seed.after.length > 16_384 || seed.before === seed.after) throw new Error("zstack_seed_invalid");
  if (text.split(seed.before).length !== 2) throw new Error("zstack_seed_not_applicable");
  return text.replace(seed.before, () => seed.after);
}

export async function replaySeed(entry, seed, { revision, ...options }) {
  const prepare = async (_entry, { cwd, scratch = os.tmpdir() }) => {
    if (!/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("zstack_revision_unavailable");
    const tree = revisionTree(cwd, revision), files = tree.map(row => row.file);
    parseReplayCheck(entry.check, files);
    const root = await mkdtemp(path.join(scratch, "zstack-seed-")), green = path.join(root, "fixed"), red = path.join(root, "seeded");
    const dispose = () => rm(root, { recursive: true, force: true });
    try {
      await projectRevision(cwd, revision, green, tree); await projectRevision(cwd, revision, red, tree);
      const input = await sourceBytes(red, seed.file);
      if (!input || input.mode === 0o120000) throw new Error("zstack_seed_invalid");
      await replaceProjectionFile(red, seed.file, Buffer.from(applySeed(input.bytes.toString("utf8"), seed)));
      await linkDependencies(cwd, green, files); await linkDependencies(cwd, red, files);
      return { fixed: revision, parent: revision, green, red, files, dispose };
    } catch (error) { await dispose(); throw error; }
  };
  const result = await replayCase({ ...entry, kind: "replay" }, { ...options, prepare });
  return { ...result, kind: "seeded", mutationSha256: createHash("sha256").update(JSON.stringify(seed)).digest("hex") };
}

export function compareEvalReceipts(before, after) {
  const valid = value => Array.isArray(value?.cases) && value.cases.length > 0 &&
    value.cases.every(row => typeof row.id === "string" && /^[a-z0-9-]+$/.test(row.id) && ["caught", "missed", "unverified"].includes(row.status)) &&
    new Set(value.cases.map(row => row.id)).size === value.cases.length;
  if (!valid(before) || !valid(after)) return { allowed: false, regressions: [], caughtDelta: null, rateDelta: null };
  const next = new Map(after.cases.map(row => [row.id, row]));
  const regressions = before.cases.filter(row => {
    const candidate = next.get(row.id);
    return !candidate || ["fixed", "parent", "checkSha256", "mutationSha256"].some(key => row[key] !== candidate[key]) ||
      row.status === "caught" && candidate.status !== "caught";
  }).map(row => row.id);
  const caught = rows => rows.filter(row => row.status === "caught").length;
  const rateDelta = caught(after.cases) / after.cases.length - caught(before.cases) / before.cases.length;
  return { allowed: regressions.length === 0 && rateDelta >= 0, regressions, caughtDelta: caught(after.cases) - caught(before.cases), rateDelta };
}
