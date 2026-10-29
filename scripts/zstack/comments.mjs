// Proves that a diff changes only comments, and measures comment density.
//
//   node scripts/zstack/comments.mjs verify --base <rev> [--head <rev>]
//       exit 1 unless every changed file differs from <base> only in comments
//       and whitespace, and no protected comment or path changed. Without
//       --head, the working tree (tracked and untracked files) is compared.
//   node scripts/zstack/comments.mjs report [--top <n>] [--json] [path...]
//       comment-only lines per file, densest first.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const PROTECTED_PATHS = [
  /(?:^|\/)migrations\//,
  /\.sql$/,
  /(?:^|\/)generated\//,
  /^third_party\//,
  /^\.github\//,
];
const GENERATED_HEADER = /@generated|\bGENERATED\b|DO NOT (?:EDIT|MODIFY)/;
const PROTECTED_COMMENT = new RegExp([
  String.raw`^\/\/\/\s*<(?:reference|amd)`,
  String.raw`@ts-(?:expect-error|ignore|nocheck|check)`,
  String.raw`\beslint-(?:disable|enable|env)|^\/\*\s*eslint\s`,
  String.raw`\bprettier-ignore\b`,
  String.raw`\b(?:biome|oxlint|stylelint)-`,
  String.raw`@vitest-environment`,
  String.raw`@vite-ignore`,
  String.raw`\bwebpack[A-Z]`,
  String.raw`[#@]__(?:PURE|NO_SIDE_EFFECTS)__`,
  String.raw`\b(?:istanbul|c8|v8) ignore\b`,
  String.raw`@jsx(?:ImportSource|Runtime|Frag)?\b`,
  String.raw`@refresh\b`,
  String.raw`^\/\*\s*global\s`,
  String.raw`@(?:license|preserve|generated)\b`,
  String.raw`\bGENERATED\b|DO NOT (?:EDIT|MODIFY)`,
  String.raw`\bCopyright\b|SPDX-License-Identifier|\bLicensed under\b`,
  String.raw`sourceMappingURL`,
  String.raw`lock_purpose`,
  String.raw`check:ui\s+ignore|gitleaks:allow|check-secrets:allow|\btslint:`,
].join("|"));
// JavaScript files can carry checked JSDoc types.
const JS_TYPE_COMMENT = /@(?:type|typedef|template|satisfies|import|callback|enum)\b|@(?:param|returns?|property|prop)\s*\{/;

const GIT_ROUTING = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES"];
const gitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_ROUTING.includes(key)));
const git = (args, cwd) => execFileSync("git", ["--no-pager", ...args], { cwd, env: gitEnvironment(), maxBuffer: 256 * 1024 * 1024 });

function scriptKind(path) {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(path, text) {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
}

// The language service lists JSDoc comments among a node's children.
const syntaxChildren = (node, sf) => node.getChildren(sf).filter((kid) =>
  kid.kind < ts.SyntaxKind.FirstJSDocNode || kid.kind > ts.SyntaxKind.LastJSDocNode);

// React and TypeScript join JSX text lines this way, so removing a comment
// between two text lines can change rendered whitespace.
function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let last = 0;
  lines.forEach((line, index) => { if (/[^ \t]/.test(line)) last = index; });
  let text = "";
  lines.forEach((line, index) => {
    let trimmed = line.replace(/\t/g, " ");
    if (index > 0) trimmed = trimmed.replace(/^ +/, "");
    if (index < lines.length - 1) trimmed = trimmed.replace(/ +$/, "");
    if (trimmed) text += index === last ? trimmed : `${trimmed} `;
  });
  return text;
}

// Each text node is cleaned on its own; adjacent cleaned text renders as one run.
function jsxChildren(node, sf) {
  const children = [];
  let raw = null, run = "";
  const clean = () => { if (raw !== null) run += jsxText(raw); raw = null; };
  const flush = () => { clean(); if (run) children.push(`JsxText(${JSON.stringify(run)})`); run = ""; };
  for (const child of node.children) {
    if (ts.isJsxText(child)) { raw = (raw ?? "") + child.text; continue; }
    if (ts.isJsxExpression(child) && !child.expression && !child.dotDotDotToken) { clean(); continue; }
    flush();
    children.push(canonical(child, sf));
  }
  flush();
  return children;
}

/** The parsed structure and token text of a node, with comments and layout removed. */
export function canonical(node, sf) {
  if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
    const open = ts.isJsxElement(node) ? node.openingElement : node.openingFragment;
    const close = ts.isJsxElement(node) ? node.closingElement : node.closingFragment;
    return `${ts.SyntaxKind[node.kind]}(${[canonical(open, sf), ...jsxChildren(node, sf), canonical(close, sf)].join(",")})`;
  }
  const kids = syntaxChildren(node, sf);
  if (kids.length === 0) {
    if (node.kind === ts.SyntaxKind.EndOfFileToken) return "EOF";
    return `${ts.SyntaxKind[node.kind]}:${node.getText(sf)}`;
  }
  return `${ts.SyntaxKind[node.kind]}(${kids.map((kid) => canonical(kid, sf)).join(",")})`;
}

/** Every comment in a file, with its text, in source order. */
export function comments(sf) {
  const text = sf.getFullText();
  const found = new Map();
  const jsxTextStarts = new Set();
  const leaves = [];
  (function walk(node) {
    if (ts.isJsxText(node)) { jsxTextStarts.add(node.pos); return; }
    const kids = syntaxChildren(node, sf);
    if (kids.length === 0) leaves.push(node);
    else kids.forEach(walk);
  })(sf);
  const add = (range) => { if (!found.has(range.pos)) found.set(range.pos, { ...range, text: text.slice(range.pos, range.end) }); };
  for (const leaf of leaves) {
    if (!jsxTextStarts.has(leaf.pos)) (ts.getLeadingCommentRanges(text, leaf.pos) ?? []).forEach(add);
    if (!jsxTextStarts.has(leaf.end)) (ts.getTrailingCommentRanges(text, leaf.end) ?? []).forEach(add);
  }
  return [...found.values()].sort((a, b) => a.pos - b.pos);
}

const shebang = (text) => (text.startsWith("#!") ? text.split("\n", 1)[0] : "");

/** Closed problems that make the change to one source file more than a comment edit. */
export function compareSource(path, before, after) {
  const problems = [];
  if (shebang(before) !== shebang(after)) problems.push({ path, code: "zstack_comments_protected_comment", detail: "shebang" });
  const a = parse(path, before), b = parse(path, after);
  if (canonical(a, a) !== canonical(b, b)) problems.push({ path, code: "zstack_comments_code_changed" });
  const remaining = new Map();
  for (const comment of comments(b)) remaining.set(comment.text, (remaining.get(comment.text) ?? 0) + 1);
  const javascript = /\.[cm]?jsx?$/.test(path);
  for (const comment of comments(a)) {
    if (!PROTECTED_COMMENT.test(comment.text) && !(javascript && JS_TYPE_COMMENT.test(comment.text))) continue;
    const left = remaining.get(comment.text) ?? 0;
    if (left > 0) remaining.set(comment.text, left - 1);
    else problems.push({ path, code: "zstack_comments_protected_comment", detail: comment.text.slice(0, 80) });
  }
  return problems;
}

function changedFiles(root, base, head) {
  const range = head ? [base, head] : [base];
  const rows = git(["diff", "--raw", "--no-renames", "-z", ...range, "--"], root).toString("utf8").split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < rows.length; index += 2) {
    const [oldMode, newMode, , , status] = rows[index].slice(1).split(" ");
    files.push({ status, path: rows[index + 1], modeChanged: oldMode !== newMode });
  }
  if (!head) {
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], root).toString("utf8").split("\0").filter(Boolean);
    for (const path of untracked) files.push({ status: "A", path });
  }
  return files;
}

const readAt = (root, rev, path) => git(["show", `${rev}:${path}`], root).toString("utf8");

/** Verify that base..head (or base..worktree) changes only comments. */
export function verifyCommentsOnly(root, { base, head } = {}) {
  if (!base) throw new Error("zstack_comments_base_required");
  const problems = [];
  const files = changedFiles(root, base, head);
  for (const { status, path, modeChanged } of files) {
    if (path === ".git-blame-ignore-revs") continue;
    if (status !== "M") { problems.push({ path, code: "zstack_comments_file_added_or_removed", detail: status }); continue; }
    if (modeChanged) { problems.push({ path, code: "zstack_comments_mode_changed" }); continue; }
    if (PROTECTED_PATHS.some((pattern) => pattern.test(path))) { problems.push({ path, code: "zstack_comments_protected_path" }); continue; }
    if (!SOURCE.test(path)) { problems.push({ path, code: "zstack_comments_unsupported_file" }); continue; }
    const before = readAt(root, base, path);
    if (GENERATED_HEADER.test(before.split("\n").slice(0, 5).join("\n"))) { problems.push({ path, code: "zstack_comments_protected_path", detail: "generated" }); continue; }
    const after = head ? readAt(root, head, path) : readFileSync(join(root, path), "utf8");
    problems.push(...compareSource(path, before, after));
  }
  return { files: files.length, problems };
}

/** Comment-only and code line counts for one source file. */
export function density(path, text) {
  const sf = parse(path, text);
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  const line = (pos) => {
    let low = 0, high = starts.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= pos) low = mid; else high = mid - 1; }
    return low;
  };
  const code = new Set(), commentLines = new Set();
  (function walk(node) {
    const kids = syntaxChildren(node, sf);
    if (kids.length === 0 || ts.isJsxText(node)) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken || (ts.isJsxText(node) && node.containsOnlyTriviaWhiteSpaces)) return;
      const start = node.getStart(sf);
      for (let at = line(start); at <= line(Math.max(start, node.end - 1)); at++) code.add(at);
      return;
    }
    kids.forEach(walk);
  })(sf);
  const all = comments(sf);
  for (const comment of all) for (let at = line(comment.pos); at <= line(Math.max(comment.pos, comment.end - 1)); at++) if (!code.has(at)) commentLines.add(at);
  return { path, comments: all.length, commentLines: commentLines.size, codeLines: code.size };
}

export function report(root, paths) {
  const listed = git(["ls-files", "-z", "--", ...paths], root).toString("utf8").split("\0").filter(Boolean);
  return listed
    .filter((path) => SOURCE.test(path) && !PROTECTED_PATHS.some((pattern) => pattern.test(path)))
    .map((path) => density(path, readFileSync(join(root, path), "utf8")))
    .filter((row) => row.comments > 0)
    .sort((a, b) => b.commentLines - a.commentLines);
}

const BANNER = /^(?:\/\/|\/\*+|\*)\s*(?:[─━═=\-*#~_]{8,}|[─━═]{3,})/;

/** Lines that are only a divider, such as `// ────` or `// =====`. */
export function bannerLines(root) {
  const listed = git(["ls-files", "-z"], root).toString("utf8").split("\0").filter(Boolean);
  let total = 0;
  for (const path of listed) {
    if (!SOURCE.test(path) || PROTECTED_PATHS.some((pattern) => pattern.test(path))) continue;
    for (const line of readFileSync(join(root, path), "utf8").split("\n")) if (BANNER.test(line.trim())) total++;
  }
  return total;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (command === "verify") {
    const result = verifyCommentsOnly(root, { base: option(args, "--base"), head: option(args, "--head") });
    console.log(JSON.stringify({ schema: "zeros.zstack-comments-verify/v1", ...result }, null, 2));
    if (result.problems.length) process.exit(1);
  } else if (command === "report") {
    const top = Number(option(args, "--top") ?? 20);
    const paths = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--top");
    const rows = report(root, paths).slice(0, top);
    if (args.includes("--json")) console.log(JSON.stringify(rows, null, 2));
    else for (const row of rows) console.log(`${String(row.commentLines).padStart(6)} ${String(row.codeLines).padStart(7)}  ${row.path}`);
  } else {
    console.error("usage: comments.mjs verify --base <rev> [--head <rev>] | report [--top <n>] [--json] [path...]");
    process.exit(2);
  }
}
