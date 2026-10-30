#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { devNull } from "node:os";
import { fileURLToPath } from "node:url";
import { lexer } from "marked";
import { redactLogSecrets, redactSensitive } from "../../packages/protocol/src/scrub.ts";
import { validateEvalCases, ZSTACK_EVALS_FILE, ZSTACK_EVAL_CASES_DIR } from "./evals.mjs";
import { childEnvironment } from "./runner.mjs";
import { repositoryPath } from "./check-plan.mjs";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const KINDS = ["all", "area", "principle", "judgment", "history"];
const MAX_BYTES = 32 * 1024 * 1024;
const PRINCIPLES = "agents/zstack/principles.md";
const ENFORCEMENT = "agents/zstack/enforcement.md";
const fail = code => { throw new Error(`zstack_history_${code}`); };
const sorted = values => [...new Set(values)].sort();
const recordPath = file => ["agents/zstack/", ".agents/", ".claude/", ".cursor/"].some(prefix => file.startsWith(prefix)) ||
  /^changelog(?:[._-]|$)/i.test(file.split("/").at(-1));

function displayText(value) {
  if (value.length > 4096) return "[text omitted: length]";
  // Omit credential-bearing subjects instead of guessing shell quoting around
  // short passwords, which an opaque-token redactor cannot recognize.
  if (/(?:^|\s)["']?(?:--(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|client[-_]?secret|credential[s]?|user|authorization)(?=[\s="']|$)|-[up])/i.test(value)) return "[redacted]";
  for (const word of value.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) {
    if (/(?:password|passwd|token|secret|key|credential)/i.test(word[0]) && /^[\\"']*\s*[=:]/.test(value.slice(word.index + word[0].length))) return "[redacted]";
  }
  const withoutUrls = value.split(/(\s+)/).map(part => part.includes("://") ? "[url]" : part).join("");
  return redactSensitive(redactLogSecrets(withoutUrls)).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
}

function optionsValid({ revision, maxCommits, limit, kind }) {
  return typeof revision === "string" && revision.length <= 256 && /^[A-Za-z0-9_][A-Za-z0-9_./~^-]*$/.test(revision) &&
    Number.isSafeInteger(maxCommits) && maxCommits >= 1 && maxCommits <= 2000 &&
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 && KINDS.includes(kind);
}

function offlineGit(cwd) {
  const env = { ...childEnvironment(), LC_ALL: "C", TZ: "UTC", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull };
  const deadline = Date.now() + 60_000;
  const supportsNoLazyFetch = spawnSync("git", ["--no-lazy-fetch", "--version"], {
    cwd, env, stdio: "pipe", timeout: 5000, maxBuffer: 4096,
  }).status === 0;
  const read = (args, input, allowNoMatch = false) => {
    if (Date.now() >= deadline) fail("git_unavailable");
    try {
      return execFileSync("git", ["--no-pager", ...(supportsNoLazyFetch ? ["--no-lazy-fetch"] : []),
        "-c", "protocol.allow=never", "-c", "color.ui=false", ...args], {
        cwd, env, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: MAX_BYTES,
        timeout: Math.min(20_000, Math.max(1, deadline - Date.now())),
      });
    } catch (error) {
      if (allowNoMatch && error.status === 1) return Buffer.alloc(0);
      fail("git_unavailable");
    }
  };
  // Older Git ignores GIT_NO_LAZY_FETCH. A full clone remains usable, but an
  // older promisor reader cannot establish the no-fetch contract.
  if (!supportsNoLazyFetch) {
    const promisors = read(["config", "--local", "--bool", "--get-regexp", "^remote\\..*\\.promisor$"], undefined, true).toString("utf8");
    const partial = read(["config", "--local", "--name-only", "--get-regexp", "^extensions\\.partialclone$"], undefined, true);
    if (/^remote\..*\.promisor true$/m.test(promisors) || partial.length) fail("git_version");
  }
  return read;
}

function packAt(git, revision) {
  const rows = git(["ls-tree", "-rz", "--full-tree", revision, "--", ZSTACK_EVALS_FILE, ZSTACK_EVAL_CASES_DIR, PRINCIPLES, ENFORCEMENT])
    .toString("utf8").split("\0").filter(Boolean);
  if (rows.length > 4096) fail("pack_limit");
  const entries = rows.map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0]+)$/.exec(row);
    if (!match || !repositoryPath(match[3])) fail("pack_invalid");
    return { oid: match[2], file: match[3] };
  }).filter(({ file }) => [ZSTACK_EVALS_FILE, PRINCIPLES, ENFORCEMENT].includes(file) || file.endsWith(".json"));
  if (![ZSTACK_EVALS_FILE, PRINCIPLES, ENFORCEMENT].every(file => entries.some(entry => entry.file === file))) fail("pack_invalid");
  const objects = git(["cat-file", "--batch"], entries.map(entry => entry.oid).join("\n") + "\n");
  const files = new Map();
  let offset = 0, size = 0;
  for (const { oid, file } of entries) {
    const end = objects.indexOf(10, offset);
    const header = /^(\w+) blob ([0-9]+)$/.exec(objects.subarray(offset, end).toString("utf8"));
    if (end < offset || !header || header[1] !== oid) fail("git_unavailable");
    const length = Number(header[2]);
    size += length;
    if (!Number.isSafeInteger(length) || length > 2 * 1024 * 1024 || size > 16 * 1024 * 1024) fail("pack_limit");
    offset = end + 1;
    if (offset + length >= objects.length || objects[offset + length] !== 10) fail("git_unavailable");
    files.set(file, objects.subarray(offset, offset + length).toString("utf8"));
    offset += length + 1;
  }
  if (offset !== objects.length) fail("git_unavailable");
  try {
    const legacy = JSON.parse(files.get(ZSTACK_EVALS_FILE));
    const cases = [...legacy.cases];
    for (const [file, text] of files) {
      if ([ZSTACK_EVALS_FILE, PRINCIPLES, ENFORCEMENT].includes(file)) continue;
      const id = file.slice(ZSTACK_EVAL_CASES_DIR.length + 1, -5), entry = JSON.parse(text);
      if (entry.id !== id) fail("pack_invalid");
      cases.push(entry);
    }
    if (cases.length > 4096) fail("pack_limit");
    if (validateEvalCases({ ...legacy, cases }).length || cases.some(entry => entry.id.length > 256)) fail("pack_invalid");
    return { cases, principles: parsePrinciples(files.get(PRINCIPLES), new Set(cases.map(entry => entry.id))), rules: parseRules(files.get(ENFORCEMENT)) };
  } catch (error) {
    if (error.message === "zstack_history_pack_limit") throw error;
    fail("pack_invalid");
  }
}

function parsePrinciples(source, ids) {
  const principles = [];
  for (const list of lexer(source).filter(token => token.type === "list" && token.ordered)) {
    for (const [index, item] of list.items.entries()) {
      const id = Number(list.start) + index;
      const title = /^\*\*([\s\S]+?)\*\*/.exec(item.text)?.[1];
      if (!Number.isSafeInteger(id) || id < 1 || id > 999 || !title || principles.some(entry => entry.id === id)) fail("pack_invalid");
      const citation = /(?:^|\n)[^\S\n]*Cases:([\s\S]*)$/.exec(item.text)?.[1] ?? "";
      const caseIds = sorted([...citation.matchAll(/`([^`]+)`/g)].map(match => match[1]));
      if (caseIds.some(caseId => !ids.has(caseId)) || citation.trim() && !caseIds.length) fail("pack_invalid");
      principles.push({ id, title: displayText(title), caseIds });
    }
  }
  if (!principles.length) fail("pack_invalid");
  return principles;
}

function parseRules(source) {
  const tables = lexer(source).filter(token => token.type === "table" && token.header[0]?.text === "Rule");
  const rules = [], seen = new Set();
  for (const row of tables.flatMap(table => table.rows)) {
    const identity = /\[([AR][1-9][0-9]*)\]\(\.\.\/\.\.\/((?:AGENTS|RULES)\.md)#([a-z0-9-]+)\)/.exec(row[0].text);
    const fingerprint = /<!-- rule:((?:AGENTS|RULES)\.md:[a-f0-9]{16}) -->/.exec(row[0].text)?.[1];
    if (!identity || !fingerprint?.startsWith(`${identity[2]}:`) || seen.has(identity[1])) fail("pack_invalid");
    seen.add(identity[1]);
    if (row[1]?.text.trim() === "judgment only") rules.push({ id: identity[1], source: identity[2], section: identity[3], fingerprint });
  }
  if (!seen.size) fail("pack_invalid");
  return rules;
}

function historyAt(git, revision, maxCommits) {
  const fields = git(["log", "--first-parent", `--max-count=${maxCommits + 1}`, "--format=%H%x00%s", "-z", revision, "--"])
    .toString("utf8").split("\0");
  if (fields.pop() !== "" || fields.length % 2) fail("git_unavailable");
  const history = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (!SHA.test(fields[index])) fail("git_unavailable");
    history.push({ sha: fields[index], rawSubject: fields[index + 1] });
  }
  return { history: history.slice(0, maxCommits), truncated: history.length > maxCommits };
}

function touchedFiles(git, commits) {
  if (!commits.length) return { files: new Map(), ignoredPaths: 0, ignoredRecordPaths: 0 };
  const known = new Set(commits.map(commit => commit.sha)), files = new Map(), records = new Set();
  const fields = git(["diff-tree", "--stdin", "--root", "--no-renames", "--name-only", "-r", "-z", "--always",
    "--diff-merges=first-parent", "--format=%x00%H"], commits.map(commit => commit.sha).join("\n") + "\n").toString("utf8").split("\0");
  let at = 0, ignoredPaths = 0;
  while (at < fields.length - 1) {
    if (fields[at++] !== "") fail("git_unavailable");
    const sha = fields[at++];
    if (!known.has(sha) || files.has(sha)) fail("git_unavailable");
    const paths = [];
    let first = true;
    while (at < fields.length - 1 && fields[at] !== "") {
      const file = first ? fields[at++].replace(/^\n/, "") : fields[at++];
      first = false;
      if (!file) continue;
      if (!repositoryPath(file)) ignoredPaths++;
      else if (recordPath(file)) records.add(file);
      else paths.push(file);
    }
    files.set(sha, sorted(paths));
  }
  if (files.size !== known.size) fail("git_unavailable");
  return { files, ignoredPaths, ignoredRecordPaths: records.size };
}

export function mineHistory(cwd, { revision = "HEAD", maxCommits = 500, limit = 10, kind = "all" } = {}) {
  if (!optionsValid({ revision, maxCommits, limit, kind })) fail("arguments_invalid");
  let git = offlineGit(cwd);
  const root = git(["rev-parse", "--show-toplevel"]).toString("utf8").trimEnd();
  git = offlineGit(root);
  const sha = git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]).toString("utf8").trim();
  if (!SHA.test(sha)) fail("git_unavailable");
  const pack = packAt(git, sha), { history, truncated } = historyAt(git, sha, maxCommits);
  const shallow = git(["rev-parse", "--is-shallow-repository"]).toString("utf8").trim();
  if (!["true", "false"].includes(shallow)) fail("git_unavailable");
  const refs = new Map();
  for (const commit of history) {
    refs.set(commit.sha, [commit.sha]);
    const pr = /\(#([1-9][0-9]*)\)$/.exec(commit.rawSubject)?.[1];
    if (pr) refs.set(`pr:${pr}`, [...(refs.get(`pr:${pr}`) ?? []), commit.sha]);
  }
  const resolveRef = ref => refs.get(ref)?.length === 1 ? refs.get(ref)[0] : null;
  const caseFixes = new Set(pack.cases.map(entry => resolveRef(entry.fixedBy)).filter(Boolean));
  const commits = history.map(commit => ({ sha: commit.sha, subject: displayText(commit.rawSubject),
    kind: /^revert(?:\b|\()/i.test(commit.rawSubject) ? "revert" :
      /^(?:fix(?:\([^\n)]*\))?!?:|fix(?:es|ed|ing)?\s)/i.test(commit.rawSubject) || caseFixes.has(commit.sha) ? "fix" : "other" }));
  const relevant = commits.filter(commit => commit.kind !== "other");
  const { files, ignoredPaths, ignoredRecordPaths } = touchedFiles(git, relevant);
  const clusters = [];
  const add = (kind, id, label, cases = [], rules = [], evidenceCommits = [], paths = []) => {
    const caseIds = sorted(cases.map(entry => entry.id)), ruleIds = sorted(rules.map(rule => rule.id));
    const reverts = evidenceCommits.filter(commit => commit.kind === "revert").length;
    const retouches = Math.max(0, evidenceCommits.filter(commit => commit.kind === "fix").length - 1);
    const score = caseIds.length * 2 + ruleIds.length * 3 + reverts * 5 + retouches * 4;
    clusters.push({ id, kind, label, score, evidence: { caseIds, ruleIds, ruleFingerprints: sorted(rules.map(rule => rule.fingerprint)),
      fixRefs: sorted(cases.map(entry => entry.fixedBy)), commits: evidenceCommits, files: paths } });
  };
  const forCases = cases => {
    const shas = new Set(cases.map(entry => resolveRef(entry.fixedBy)).filter(Boolean));
    return commits.filter(commit => shas.has(commit.sha));
  };
  for (const area of sorted(pack.cases.map(entry => entry.area))) {
    const cases = pack.cases.filter(entry => entry.area === area);
    add("area", `area:${area}`, area, cases, [], forCases(cases));
  }
  for (const principle of pack.principles.filter(entry => entry.caseIds.length)) {
    const cases = pack.cases.filter(entry => principle.caseIds.includes(entry.id));
    add("principle", `principle:${principle.id}`, principle.title, cases, [], forCases(cases));
  }
  for (const key of sorted(pack.rules.map(rule => `${rule.source}#${rule.section}`)))
    add("judgment", `judgment:${key}`, key, [], pack.rules.filter(rule => `${rule.source}#${rule.section}` === key));
  const byPath = new Map();
  for (const commit of relevant) for (const file of files.get(commit.sha)) {
    if (!byPath.has(file)) byPath.set(file, []);
    byPath.get(file).push(commit);
  }
  if (byPath.size > 20_000) fail("output_limit");
  for (const [file, evidenceCommits] of byPath) {
    if (evidenceCommits.length < 2 && !evidenceCommits.some(commit => commit.kind === "revert")) continue;
    const shas = new Set(evidenceCommits.map(commit => commit.sha));
    add("history", `history:${file}`, file, pack.cases.filter(entry => shas.has(resolveRef(entry.fixedBy))), [], evidenceCommits, [file]);
  }
  clusters.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = clusters.filter(cluster => kind === "all" || cluster.kind === kind);
  const cited = new Set(pack.principles.flatMap(principle => principle.caseIds));
  return { schema: "zeros.zstack-history/v1", revision: sha,
    coverage: { maxCommits, historyCommits: history.length, historyTruncated: truncated, shallow: shallow === "true",
      cases: pack.cases.length, principles: pack.principles.length, uncitedCases: pack.cases.filter(entry => !cited.has(entry.id)).length,
      judgmentRules: pack.rules.length, ignoredPaths, ignoredRecordPaths, unresolvedFixRefs: sorted(pack.cases.map(entry => entry.fixedBy).filter(ref => !resolveRef(ref))) },
    selection: { kind, limit }, ranking: { case: 2, judgmentRule: 3, revert: 5, additionalFix: 4 }, totalClusters: selected.length,
    clusters: selected.slice(0, limit).map((cluster, index) => ({ rank: index + 1, ...cluster })) };
}

export function formatHistory(report) {
  const cell = text => text.replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
  const sample = values => values.slice(0, 3).map(cell).join("; ") + (values.length > 3 ? `; +${values.length - 3} (--json)` : "");
  const lines = [`Revision: ${report.revision}`, `History: ${report.coverage.historyCommits}/${report.coverage.maxCommits} commits; truncated=${report.coverage.historyTruncated}; shallow=${report.coverage.shallow}`,
    `Pack: ${report.coverage.cases} cases; ${report.coverage.judgmentRules} judgment-only rules; ${report.coverage.uncitedCases} uncited cases; ${report.coverage.unresolvedFixRefs.length} unresolved fix references.`,
    `File clusters exclude ${report.coverage.ignoredRecordPaths} unique record paths (pack, provider metadata, changelogs); docs/ remains eligible.`,
    `Clusters (${report.selection.kind}): ${report.clusters.length}/${report.totalClusters}. Evidence samples below; --json retains all evidence.`,
    "| Rank | Score | Cluster | Case IDs | Rule IDs | Commits (subject only) |", "| --- | --- | --- | --- | --- | --- |"];
  for (const cluster of report.clusters) lines.push(`| ${cluster.rank} | ${cluster.score} | ${cell(cluster.id + (cluster.kind === "principle" ? `: ${cluster.label}` : ""))} | ${sample(cluster.evidence.caseIds)} | ${sample(cluster.evidence.ruleIds)} | ${sample(cluster.evidence.commits.map(commit => `${commit.sha.slice(0, 12)} ${commit.subject}`))} |`);
  return lines.join("\n") + "\n";
}

export function runCli({ argv = process.argv.slice(2), cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = {}, seen = new Set();
    let json = false;
    for (let at = 0; at < argv.length; at++) {
      const flag = argv[at];
      if (!["--json", "--revision", "--max-commits", "--limit", "--kind"].includes(flag) || seen.has(flag)) fail("arguments_invalid");
      seen.add(flag);
      if (flag === "--json") { json = true; continue; }
      const value = argv[++at];
      if (!value || value.startsWith("--")) fail("arguments_invalid");
      options[flag === "--max-commits" ? "maxCommits" : flag.slice(2)] = ["--revision", "--kind"].includes(flag) ? value : /^[0-9]+$/.test(value) ? Number(value) : NaN;
    }
    const report = mineHistory(cwd, options), output = json ? JSON.stringify(report, null, 2) + "\n" : formatHistory(report);
    if (Buffer.byteLength(output) > 8 * 1024 * 1024) fail("output_limit");
    stdout.write(output);
    return 0;
  } catch (error) {
    const code = /^zstack_history_[a-z_]+$/.test(error?.message ?? "") ? error.message : "zstack_history_unavailable";
    stderr.write(`${code}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = runCli();
