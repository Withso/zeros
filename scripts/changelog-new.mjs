#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// changelog-new.mjs — scaffold a curated, milestone PUBLIC changelog entry
// ──────────────────────────────────────────────────────────
//
// TWO-TIER changelog model:
//
//   • Per-release notes (AUTOMATIC, technical) — every `release.yml` run
//     publishes a GitHub Release with auto-generated PR notes. One per release
//     (0.0.1, 0.0.2, …). No manual work. Audience: testers / the curious.
//
//   • Public changelog (CURATED, milestone) — THIS script. You do NOT cut one
//     per release; you cut one when there's a story worth telling, and it
//     CONSOLIDATES every release since the last published entry (e.g. one
//     "0.1.0" entry rolls up 0.0.5 … 0.0.12). It renders at
//     zeros.build/changelog. Audience: the public. Separate markdown, separate
//     flow — nothing publishes until you commit + push (that's the review gate;
//     Cloudflare Pages gives a branch preview before it goes live on main).
//
// This helper drafts the editable entry: it gathers every commit since the last
// published entry, groups them into sections, optionally asks your LOCAL `claude`
// CLI to draft user-facing highlights (--ai; runs on your machine, never in CI),
// and creates the media folder so you can drop images/videos.
//
// Usage:
//   pnpm changelog:new --version 0.1.0          # the milestone label (recommended)
//   pnpm changelog:new --version 0.1.0 --ai     # also draft highlights via local claude
//   pnpm changelog:new --version 0.1.0 --since v0.0.4   # explicit consolidation start
//   pnpm changelog:new --version 0.1.0 --count 30       # last N commits instead
//
// Then: edit the highlights in your own words, drop media into
//   apps/marketing/public/changelog/<version>/  and embed it, commit + push.
// Cloudflare Pages auto-deploys apps/marketing → the entry goes live.
// ──────────────────────────────────────────────────────────

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = join(
  ROOT,
  "apps",
  "marketing",
  "src",
  "content",
  "changelog",
);
const MEDIA_ROOT = join(ROOT, "apps", "marketing", "public", "changelog");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function hasFlag(name) {
  return process.argv.includes(name);
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: ROOT }).toString().trim();
}

/** Parse "1.2.3" → comparable tuple. */
function semverKey(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : -1;
}

/** Highest-version existing entry filename (without .md), or null. */
function latestEntryVersion() {
  if (!existsSync(CONTENT_DIR)) return null;
  const versions = readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort((a, b) => semverKey(b) - semverKey(a));
  return versions[0] ?? null;
}

function resolveVersion() {
  const pinned = arg("--version");
  if (pinned) return pinned.trim();
  // A public entry is a MILESTONE you name on purpose — fall back to the
  // auto-computed next version, but you'll usually pass --version explicitly.
  try {
    return execSync("node scripts/compute-version.mjs", { cwd: ROOT })
      .toString()
      .trim();
  } catch {
    return "0.0.0";
  }
}

function resolveRange() {
  const since = arg("--since");
  if (since) return `${since}..HEAD`;

  const count = arg("--count");
  if (count) return `HEAD~${Number(count)}..HEAD`;

  // Default = CONSOLIDATE: everything since the commit that introduced the last
  // published entry. This is what rolls up all the intermediate releases into
  // one milestone entry.
  const last = latestEntryVersion();
  if (last) {
    const file = join(CONTENT_DIR, `${last}.md`);
    const sha = git(`log -1 --format=%H -- "${file}"`);
    if (sha) return `${sha}..HEAD`;
  }
  // No prior entry committed yet → last 20 commits (clamped to history length).
  const total = Number(git("rev-list --count HEAD"));
  return `HEAD~${Math.min(20, Math.max(1, total - 1))}..HEAD`;
}

function collectCommits(range) {
  // Non-merge commit subjects + short sha. Squash-merge PR titles look like
  // "Some change (#34)". %x1f = literal 0x1F unit-separator → safe delimiter.
  const out = git(`log --no-merges --pretty=format:'%s%x1f%h' ${range}`);
  if (!out) return [];
  return out.split("\n").map((line) => {
    const [subject, sha] = line.split("\x1f");
    return { subject, sha };
  });
}

/** Release tags whose commit falls inside the range — so the entry can note
 *  exactly which releases it consolidates (e.g. "Consolidates v0.0.5 … v0.0.12"). */
function tagsInRange(range) {
  let shasInRange;
  try {
    shasInRange = new Set(
      git(`log --pretty=%H ${range}`).split("\n").filter(Boolean),
    );
  } catch {
    return [];
  }
  let refs;
  try {
    refs = git("show-ref --tags").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const tags = [];
  for (const line of refs) {
    const [sha, ref] = line.split(" ");
    const name = ref?.replace("refs/tags/", "");
    if (name && shasInRange.has(sha) && /^v\d+\.\d+\.\d+$/.test(name))
      tags.push(name);
  }
  return tags.sort((a, b) => semverKey(a) - semverKey(b));
}

// ── Commit categorization (best-effort, for the reference block) ──
// Commits are squash-merged PR titles; PR LABELS (used by .github/release.yml)
// aren't in git, so group by any conventional `type(scope):` prefix instead.
// Everything else lands in "Other" for you to triage. This is just to organize
// the draft — you rewrite it in your own voice.
const CATEGORY_BY_TYPE = {
  feat: "✨ Features",
  feature: "✨ Features",
  fix: "🐛 Fixes",
  bug: "🐛 Fixes",
  bugfix: "🐛 Fixes",
  perf: "⚡ Performance",
  refactor: "🛠️ Under the hood",
  chore: "🛠️ Under the hood",
  build: "🛠️ Under the hood",
  ci: "🛠️ Under the hood",
  test: "🛠️ Under the hood",
  docs: "🛠️ Under the hood",
  style: "🛠️ Under the hood",
};
const OTHER = "📌 Other changes";
const CATEGORY_ORDER = [
  "✨ Features",
  "⚡ Performance",
  "🐛 Fixes",
  OTHER,
  "🛠️ Under the hood",
];

function categorize(commits) {
  const groups = new Map();
  for (const c of commits) {
    const m = /^(\w+)(?:\([^)]*\))?(!)?:\s*(.*)$/.exec(c.subject);
    const cat = (m && CATEGORY_BY_TYPE[m[1].toLowerCase()]) || OTHER;
    // Strip the conventional prefix + trailing "(#NN)" for a cleaner reference.
    const clean = (m ? m[3] : c.subject).replace(/\s*\(#\d+\)\s*$/, "").trim();
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push({ ...c, clean });
  }
  return groups;
}

function renderGroupedReference(groups) {
  const out = [];
  for (const cat of CATEGORY_ORDER) {
    const items = groups.get(cat);
    if (!items?.length) continue;
    out.push(`**${cat}**`, "");
    for (const c of items) out.push(`- ${c.clean} (\`${c.sha}\`)`);
    out.push("");
  }
  return out.join("\n").trim();
}

/** Ask the LOCAL `claude` CLI to draft user-facing highlights. Opt-in (--ai),
 *  runs on YOUR machine via your own Claude auth — never in CI, no API key, no
 *  surprise billing. Returns markdown, or null if claude is unavailable/fails
 *  (caller falls back to the categorized scaffold). */
function aiDraft(version, commits) {
  const claudeAvailable = (() => {
    try {
      execFileSync("command", ["-v", "claude"], {
        shell: "/bin/bash",
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  })();
  if (!claudeAvailable) {
    console.warn(
      "⚠ --ai: `claude` CLI not found on PATH — falling back to the plain scaffold.",
    );
    return null;
  }

  const bullets = commits.map((c) => `- ${c.subject}`).join("\n");
  const prompt = [
    "You are writing the PUBLIC changelog for Zeros, a Mac app where parallel AI",
    "agents design, build, and ship code across isolated git worktrees.",
    "",
    `Below are the squash-merged commit / PR titles since the last published`,
    `changelog entry. Write the user-facing highlights for version ${version} as`,
    "GitHub-flavored Markdown.",
    "",
    "Rules:",
    "- Audience is END USERS, not developers. Translate technical commits into",
    "  user-visible value; omit pure chores/CI/refactors unless they matter to",
    "  users (faster, more reliable, fewer crashes).",
    "- Group into 2–5 short sections with `##` headers (e.g. `## Agents`,",
    "  `## Design canvas`, `## Fixes`). Bullets under each.",
    "- Lead each bullet with the benefit, in a concise confident voice. NO commit",
    "  hashes, NO PR numbers, NO 'we refactored'.",
    "- Output ONLY the markdown body — no frontmatter, no preamble, no surrounding",
    "  code fence.",
    "",
    "Commits:",
    bullets,
  ].join("\n");

  try {
    console.log(
      "⠿ --ai: drafting highlights with your local claude CLI (this is a draft to edit)…",
    );
    const out = execFileSync("claude", ["-p", prompt], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
    return out || null;
  } catch (err) {
    console.warn(
      `⚠ --ai: claude draft failed (${err?.message ?? err}) — falling back to the plain scaffold.`,
    );
    return null;
  }
}

function main() {
  const version = resolveVersion();
  // Used as a filename + public URL segment — keep it a plain semver so a stray
  // `--version ../../x` can't write outside the content dir.
  if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(
      `✗ Invalid version "${version}". Expected MAJOR.MINOR.PATCH.`,
    );
    process.exit(1);
  }

  const outFile = join(CONTENT_DIR, `${version}.md`);
  if (existsSync(outFile)) {
    console.error(`✗ Entry already exists: ${outFile}`);
    console.error(
      `  Edit it directly, or pass --version <other> for a new one.`,
    );
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const range = resolveRange();
  const commits = collectCommits(range);
  const tags = tagsInRange(range);
  const groups = categorize(commits);

  const wantAi = hasFlag("--ai");
  const ai = wantAi && commits.length ? aiDraft(version, commits) : null;

  // The "Highlights" section: AI draft if we got one, else an empty stub to fill.
  const highlights = ai
    ? `<!-- AI DRAFT — review, fact-check, and edit before publishing. -->\n\n${ai}`
    : "## Highlights\n\n- ";

  const consolidates = tags.length
    ? `Consolidates ${tags.length} release${tags.length === 1 ? "" : "s"}: ${tags[0]} … ${tags[tags.length - 1]}.`
    : "";

  mkdirSync(CONTENT_DIR, { recursive: true });

  const body = `---
version: "${version}"
date: "${date}"
title: "Zeros ${version}"
summary: ""
---

<!--
  PUBLIC changelog entry (zeros.build/changelog) — milestone, consolidated, in
  YOUR words. ${consolidates}
  The front matter above is scaffolded with safe defaults so a half-edited
  entry still renders: replace "title" with a real headline, and fill
  "summary" with the one sentence shown in the changelog index (an empty
  summary renders as no summary — it is never a placeholder string).
  Add media under  apps/marketing/public/changelog/${version}/  and embed:
    ![Alt text](/changelog/${version}/screenshot.png)
    <video src="/changelog/${version}/demo.mp4" controls playsinline width="100%"></video>
  Delete this comment + the reference block below before publishing.
-->

${highlights}

<details>
<summary>Commits in this milestone (reference — edit or delete before publishing)</summary>

${renderGroupedReference(groups) || "- (no commits found in range — pass --since / --count)"}

</details>
`;

  writeFileSync(outFile, body);

  // Create the media drop folder so there's an obvious place for images/videos.
  // (Empty dirs aren't tracked by git, so this adds no noise if you stay text-only.)
  const mediaDir = join(MEDIA_ROOT, version);
  mkdirSync(mediaDir, { recursive: true });

  console.log(`✓ Drafted ${outFile}`);
  console.log(
    `  Range:  ${range}  (${commits.length} commit${commits.length === 1 ? "" : "s"})`,
  );
  if (tags.length) console.log(`  ${consolidates}`);
  if (ai)
    console.log(
      `  Highlights: AI-drafted via local claude — REVIEW + edit before publishing.`,
    );
  console.log(`  Media:  ${mediaDir}/`);
  console.log(`\nNext:`);
  console.log(`  1. Edit the title, summary + highlights in your own words.`);
  console.log(
    `  2. Drop images/videos into apps/marketing/public/changelog/${version}/ and embed them.`,
  );
  console.log(
    `  3. Push to a branch → Cloudflare preview, then merge to main → live at zeros.build/changelog.`,
  );
}

main();
