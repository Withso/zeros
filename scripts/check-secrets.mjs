#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-secrets — fail if a real secret, or an identity leak, is committed
// ──────────────────────────────────────────────────────────
//
// A deterministic, dependency-free gate for the Preflight CI suite. It scans
// TRACKED files (git ls-files — so node_modules/dist/binaries and anything
// gitignored, including .env, are excluded) for two classes of problem:
//
//   1. SECRETS — the high-risk credential shapes THIS repo handles, each
//      anchored on a realistic secret BODY so a bare prefix in prose or in
//      .env.example does NOT trip it.
//   2. IDENTITY — the maintainer's personal handles, private machine paths and
//      unrelated side-project names. This repo is public; the scrub that
//      removed them was a one-shot, and without a ratchet the next paste or the
//      next AI-written comment quietly puts them back.
//
// Why markdown is NOT excluded any more: it used to be, on the theory that docs
// legitimately quote token *prefixes*. That exclusion is exactly why real email
// addresses and production user UUIDs survived in prose for months. Every rule
// below is anchored on a realistic body, so documentation that merely names a
// prefix ("keys look like `sk-ant-…`") still cannot match. Prose gets scanned.
//
// Scope notes:
//   • *.example and the lockfile stay excluded — placeholders and integrity
//     hashes, by construction not real credentials.
//   • The public-by-design bundled keys are NOT matched: Supabase
//     `sb_publishable_…` and the PostHog `phc_…` project key are
//     write-only/RLS-gated and meant to ship. Only their privileged siblings
//     (`sb_secret_`, `phx_`) are flagged. The LEGACY Supabase anon JWT is
//     flagged even though it is public-by-design: its modern replacement is
//     `sb_publishable_`, so a JWT in a tracked file today is far more likely to
//     be a mis-pasted service_role key than a deliberate anon key.
//
// Intentionally deterministic + high-precision (no entropy heuristics) so it is
// safe to block on. A fuller gitleaks/trufflehog scan with entropy detection
// over FULL HISTORY (this only ever sees the current tree) is a separate, and
// still necessary, job.
//
// Run: `pnpm check:secrets`. Exit 0 = clean, 1 = something was found.
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ── 1. Credential shapes ──────────────────────────────────
//
// Each regex demands a realistic secret BODY after the prefix, so the bare
// prefix appearing in prose (this repo's own docs use these prefixes as
// examples) cannot match.
const RULES = [
  { name: "PostHog personal API key (phx_)", re: /\bphx_[A-Za-z0-9]{32,}/ },
  {
    name: "Supabase secret/service key (sb_secret_)",
    re: /\bsb_secret_[A-Za-z0-9_-]{20,}/,
  },
  { name: "Anthropic API key (sk-ant-)", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "OpenAI API key (sk-…)", re: /\bsk-(?:proj-)?[A-Za-z0-9]{40,}/ },
  { name: "GitHub PAT (ghp_/gho_)", re: /\bgh[po]_[A-Za-z0-9]{36,}/ },
  {
    name: "GitHub App/user token (ghs_/ghu_/ghr_)",
    re: /\b(?:ghs_\d+_[A-Za-z0-9._-]{40,}|ghs_[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{8,})+|gh[sur]_[A-Za-z0-9]{36,})\b/,
  },
  {
    name: "GitHub fine-grained PAT (github_pat_)",
    re: /\bgithub_pat_[A-Za-z0-9_]{50,}/,
  },
  { name: "AWS access key id (AKIA)", re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "Private key block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  // Database URLs that carry credentials AND point somewhere real. The host
  // negative-lookahead keeps the everyday local fixtures green
  // (postgres://postgres:postgres@localhost:5432/… in CI services and
  // backend/.env.example) while catching a managed/pooler endpoint — which is
  // how a production Postgres URL slipped into the tree unnoticed. Note that a
  // Supabase pooler URL carries the project ref in the USERNAME and often no
  // password at all, so a password is deliberately not required.
  {
    name: "Database URL with credentials (non-local host)",
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^\s"'`/@]+@(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|db[:/\s])[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}/,
  },
  // A Supabase project ref is exactly 20 lowercase alphanumerics. Anchoring on
  // that length keeps placeholders (`<ref>.supabase.co`, `ref.supabase.co`)
  // from matching while pinning a real project's hostname — which is enough to
  // enumerate its public API surface. Kept even though the product no longer
  // uses Supabase: this gate scans for credentials that leak IN, and material
  // from a retired project is exactly what gets pasted back into a repo.
  {
    name: "Supabase project ref hostname",
    re: /\b[a-z0-9]{20}\.supabase\.(?:co|in|net)\b/,
  },
];

// Supabase-issued JWTs are the one shape a plain regex cannot judge: the danger
// is entirely in the payload's `role`. Match a three-segment JWT, then decode
// the middle segment and only flag a Supabase-shaped claim set. This keeps
// synthetic JWT fixtures (packages/core's redaction tests build `eyJaaa…`
// strings that decode to nothing) out of the findings.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.([A-Za-z0-9_-]{12,})\.[A-Za-z0-9_-]{8,}\b/g;

function supabaseJwtRole(line) {
  JWT_RE.lastIndex = 0;
  let m;
  while ((m = JWT_RE.exec(line)) !== null) {
    let payload;
    try {
      payload = Buffer.from(m[1], "base64url").toString("utf8");
    } catch {
      continue;
    }
    if (!/[{,]\s*"/.test(payload)) continue; // not JSON — random base64
    const role = /"role"\s*:\s*"(service_role|anon)"/.exec(payload);
    if (role) return role[1];
    // `iss: supabase` with any role is still a project-scoped token.
    if (/"iss"\s*:\s*"[^"]*supabase/.test(payload)) return "supabase";
  }
  return null;
}

/** An obvious placeholder, not a credential: strip the vendor prefix and the
 *  remaining body is one character repeated (`ghp_0000…`, `sk-ant-xxxx…`,
 *  `AKIA0000000000000000`). Test fixtures need a token of REALISTIC LENGTH to
 *  exercise length-dependent masking/redaction, so they cannot simply be
 *  shortened below a rule threshold — and a body with ≤ 2 distinct characters
 *  carries no entropy and cannot be a real key. Anything more varied is treated
 *  as real. Rules whose match is a whole URL have no prefix to strip, so the
 *  full match is scored and they never qualify. */
const SECRET_PREFIX_RE =
  /^(?:AKIA|github_pat_|gh[pousr]_|sk-ant-(?:api\d\d-)?|sk-proj-|sk-|phx_|sb_secret_)/;

function looksLikePlaceholder(match) {
  const body = match.replace(SECRET_PREFIX_RE, "").replace(/[^A-Za-z0-9]/g, "");
  if (body.length < 8) return false;
  return new Set(body).size <= 2;
}

// ── 2. Identity ratchet ───────────────────────────────────
//
// These are not secrets — they are the strings that de-anonymise the
// maintainer, name unrelated private products, or point at a personal machine.
// They must never re-enter the tree. The scrub that removed them was one-shot;
// without a ratchet the next paste or the next AI-written comment puts them
// back.
//
// WHY THE PATTERNS ARE BASE64 AND NOT PLAINTEXT
// Encoding is not security — it reverses with one `atob`. It exists because
// this file is tracked in a PUBLIC repo: written literally, the ratchet would
// become the single place GitHub code search still indexes every string the
// scrub just removed, which is precisely the leak it is meant to prevent.
// Encoding also lets the gate scan ITSELF instead of needing an exclusion,
// closing the hole a self-exclusion would open. To read or extend the list:
//   node -e 'console.log(Buffer.from("<src>","base64").toString())'
//
// Findings are reported by category and file:line, never by echoing the
// matched text — same reason.
//
// Replacement vocabulary for fixtures/examples, so nobody has to invent one:
//   person   Jordan Lee <jordan@example.com>   (second: Sam Rivera)
//   repo     acme/example  ·  https://github.com/acme/example
//   path     /Users/dev/Projects/example
//   uuid     00000000-0000-0000-0000-000000000000
//   subject  oauth2|000000000
const decodePattern = (src) => Buffer.from(src, "base64").toString("utf8");

const IDENTITY_RULES = [
  // Personal handles, in one alternation: they overlap by construction, and
  // one bullet per offending line is what a human needs to go fix it.
  { name: "personal handle", src: "YXJ1bnJhamt1bWFyfGlhbWFydW5ya3xhcnVucmt8YXJ1bnJhag==", flags: "i" },
  { name: "personal name", src: "XGJBcnVuW1xzLl8tXT9SYWpcYg==", flags: "i" },
  { name: "internal email domain", src: "QHdpdGhzb1wuY29tXGI=", flags: "i" },
  { name: "personal machine path", src: "L1VzZXJzL2FydW5yYWprdW1hcg==", flags: "i" },
  { name: "unrelated side project", src: "XGIwKD86a2l0fGNvbG9yc3xjYW52YXN8YWNjb3VudHN8cmVzZWFyY2h8c2hhcmVkKVxi", flags: "i" },
  // Case-SENSITIVE on the product name, plus its domain. Deliberately does NOT
  // match the bare lowercase directory token used as a path glob for an
  // external worktree tool's scratch dir — tooling (the Vite watcher ignore
  // list, .gitignore) still has to name that directory to skip it. What must
  // not appear is the product NAME in prose or comments.
  //
  // `skip` — NOT APPLIED UNDER docs/. This is the only scoped hole in the
  // ratchet, and this is the only rule that has one. docs/ became TRACKED on
  // 2026-07-28; it was gitignored when this rule was written, so the original
  // "or docs" wording meant markdown that shipped in the repo, not this journal.
  // Part of the journal is a comparative study of the external worktree tool —
  // the numbered pack under docs/cloud-workspace/ plus scattered prior-art notes,
  // 480 lines that NAME it because naming it IS the content. No fixture
  // substitution works: a euphemism still leaves files titled
  // `…-how-conductor-does-it.md` and prose unmistakably about one product, so it
  // would defeat the check while appearing to satisfy it — worse than a declared
  // exception. The line-level ALLOW_IDENTITY hatch is the intended tool for
  // "can't be fixed", but 480 markers is not a reviewable diff.
  //
  // Every OTHER identity rule still scans docs/ and is enforced there — handles,
  // real name, internal email domain, machine paths, side projects. (Publishing
  // scrubbed 61 such identifiers out of docs/, including production user UUIDs,
  // provider subjects and OAuth client IDs.) Every SECRET rule still scans docs/
  // and always will: secret shapes can never be suppressed. To undo this, drop
  // the `skip` and untrack docs/cloud-workspace/ — that pack is 387 of the 480.
  { name: "other product", src: "XGJDb25kdWN0b3JcYnxcYmNvbmR1Y3RvclwuYnVpbGRcYg==", flags: "", skip: (p) => p.startsWith("docs/") },
].map((r) => ({ name: r.name, re: new RegExp(decodePattern(r.src), r.flags), skip: r.skip }));

// ── 3. Exclusions ─────────────────────────────────────────
//
// Narrow and individually justified. Anything added here is a hole in the gate,
// so each entry states WHY the file cannot be cleaned instead.
const isExcluded = (p) =>
  // Placeholders by construction (.env.example et al) — never real values.
  p.includes(".example") ||
  // Registry integrity hashes; base64 noise, no human-authored content.
  p === "pnpm-lock.yaml" ||
  p === "backend/pnpm-lock.yaml" ||
  // NOTE: this file is deliberately NOT excluded. Its identity patterns are
  // base64-encoded precisely so the gate can scan itself.
  //
  // The external worktree tool's OWN config file. Its name and schema URL are
  // the file's entire content; it is kept deliberately and is local tooling
  // config, not product source or documentation.
  p.startsWith(".conductor/");

// Line-level escape hatch, for the rare case where an identity match is a
// genuine interop value rather than prose — e.g. the display label for an
// external tool this app deliberately detects and names in its UI. Prefer
// fixing the line; this exists so that "can't be fixed" is a visible,
// reviewable, grep-able decision instead of a whole-file exclusion.
//
//   someLabel: "Tool",  // check-secrets:allow-identity — user-visible label
//
// Applies only to the identity ratchet. Secret shapes can never be suppressed.
const ALLOW_IDENTITY = "check-secrets:allow-identity";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const secretFindings = [];
const identityFindings = [];

for (const file of tracked) {
  if (isExcluded(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable
  }
  if (text.includes("\0")) continue; // skip binary
  text.split("\n").forEach((line, i) => {
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m && !looksLikePlaceholder(m[0]))
        secretFindings.push({ file, line: i + 1, rule: rule.name });
    }
    const role = line.includes("eyJ") ? supabaseJwtRole(line) : null;
    if (role)
      secretFindings.push({
        file,
        line: i + 1,
        rule: `Supabase JWT (role=${role})`,
      });
    // First match per line only. Several rules overlap by construction (a
    // handle can be a substring of a longer one), and one bullet per offending
    // line is what a human actually needs to go fix it.
    if (line.includes(ALLOW_IDENTITY)) return;
    for (const rule of IDENTITY_RULES) {
      // A path-scoped rule skips WITHOUT consuming the line, so the rules after
      // it still get their shot at it (see the "other product" note above).
      if (rule.skip?.(file)) continue;
      if (rule.re.test(line)) {
        identityFindings.push({ file, line: i + 1, rule: rule.name });
        break;
      }
    }
  });
}

const bullet = (f) => console.error(`  • ${f.file}:${f.line} — ${f.rule}`);

if (secretFindings.length > 0) {
  console.error("✖ check:secrets — possible committed secret(s):");
  secretFindings.forEach(bullet);
  console.error(
    "\nIf this is a false positive, narrow the rule or add a scoped exclusion in scripts/check-secrets.mjs.",
  );
}

if (identityFindings.length > 0) {
  console.error(
    `${secretFindings.length ? "\n" : ""}✖ check:secrets — identity leak(s) in tracked files:`,
  );
  identityFindings.forEach(bullet);
  console.error(
    "\nThis repository is public. Replace the identifier with the fixture vocabulary\n" +
      "documented in scripts/check-secrets.mjs (Jordan Lee / jordan@example.com /\n" +
      "acme/example / /Users/dev/... / 00000000-0000-0000-0000-000000000000).",
  );
}

if (secretFindings.length > 0 || identityFindings.length > 0) process.exit(1);

console.log(
  `✓ check:secrets — scanned ${tracked.length} tracked files, no secrets found`,
);
