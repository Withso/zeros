#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// check-secrets — fail if a high-confidence credential is committed
// ──────────────────────────────────────────────────────────
//
// A deterministic, dependency-free gate for the Preflight CI suite. It scans
// TRACKED files (git ls-files — so node_modules, build output, binaries, and
// gitignored local .env files are excluded). Every rule is anchored on a
// realistic credential body so a bare prefix in prose or in an example file
// does not trip it.
//
// Why markdown is NOT excluded any more: it used to be, on the theory that docs
// legitimately quote token *prefixes*. That exclusion is exactly why real email
// addresses and production user UUIDs survived in prose for months. Every rule
// below is anchored on a realistic body, so documentation that merely names a
// prefix ("keys look like `sk-ant-…`") still cannot match. Prose gets scanned.
//
// Scope notes:
//   • Example files, lockfiles, and workspace-tool configuration are scanned.
//     Placeholder detection and precise credential shapes keep them usable
//     without creating blanket blind spots.
//   • The public-by-design bundled keys are NOT matched: Supabase
//     `sb_publishable_…` and the PostHog `phc_…` project key are
//     write-only/RLS-gated and meant to ship. Only their privileged siblings
//     (`sb_secret_`, `phx_`) are flagged. The LEGACY Supabase anon JWT is
//     flagged even though it is public-by-design: its modern replacement is
//     `sb_publishable_`, so a JWT in a tracked file today is far more likely to
//     be a mis-pasted service_role key than a deliberate anon key.
//
// Intentionally deterministic + high-precision (no entropy heuristics) so it is
// safe to block on. The pinned Gitleaks job in preflight.yml scans every commit
// introduced by a PR; this script supplements it with repository-specific
// shapes and a fast current-tree check.
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
  { name: "GitLab PAT (glpat-)", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: "npm access token (npm_)", re: /\bnpm_[A-Za-z0-9]{36,}/ },
  { name: "Slack token (xox…)", re: /\bxox[baprs]-[A-Za-z0-9-]{20,}/ },
  { name: "Linear API key (lin_api_)", re: /\blin_api_[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key (AIza)", re: /\bAIza[A-Za-z0-9_-]{35}\b/ },
  {
    name: "Stripe live secret key",
    re: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}/,
  },
  { name: "AWS access key id (AKIA)", re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "Private key block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  // Database URLs that carry credentials AND point somewhere real. The host
  // negative-lookahead keeps the everyday local fixtures green
  // (postgres://postgres:postgres@localhost:5432/… in CI services and
  // apps/control-plane/.env.example) while catching a managed/pooler endpoint — which is
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
// synthetic JWT fixtures (packages/protocol's redaction tests build `eyJaaa…`
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
  /^(?:AKIA|AIza|github_pat_|gh[pousr]_|glpat-|npm_|xox[baprs]-|lin_api_|(?:sk|rk)_live_|sk-ant-(?:api\d\d-)?|sk-proj-|sk-|phx_|sb_secret_)/;

function looksLikePlaceholder(match) {
  const body = match.replace(SECRET_PREFIX_RE, "").replace(/[^A-Za-z0-9]/g, "");
  if (body.length < 8) return false;
  return new Set(body).size <= 2;
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const secretFindings = [];

for (const file of tracked) {
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
  });
}

const bullet = (f) => console.error(`  • ${f.file}:${f.line} — ${f.rule}`);

if (secretFindings.length > 0) {
  console.error("✖ check:secrets — possible committed secret(s):");
  secretFindings.forEach(bullet);
  console.error(
    "\nIf this is a false positive, narrow the matching rule without excluding an entire file class.",
  );
}

if (secretFindings.length > 0) process.exit(1);

console.log(
  `✓ check:secrets — scanned ${tracked.length} tracked files, no secrets found`,
);
