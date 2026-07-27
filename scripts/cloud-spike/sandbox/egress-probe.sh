#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# egress-probe.sh — §14 #4: which hosts can a sandbox reach?
# ──────────────────────────────────────────────────────────
#
# Runs INSIDE the sandbox (driven by egress.ts). Daytona T1/T2 are allowlist-only
# egress; T3/T4 are open. The load-bearing question is Cursor: `@cursor/sdk` dials
# `*.cursor.sh` hosts that are NOT on the T1/T2 allowlist → Cursor agents likely
# need Tier 3. This prints a reachable/BLOCKED table so the operator can confirm
# the tier before Phase 6 wires Cursor.
#
# Classification: ANY HTTP response (even 401/403/404) ⇒ the host is REACHABLE
# (egress allowed). A connect timeout / refusal / DNS failure ⇒ BLOCKED.
# ──────────────────────────────────────────────────────────
set -uo pipefail

probe() {
  local label="$1" url="$2"
  # -s silent, -o /dev/null, -w status, fail fast on connect, cap total time.
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 6 --max-time 12 "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "000" ]]; then
    printf '  %-12s %-42s  \033[31mBLOCKED\033[0m (no HTTP response)\n' "$label" "$url"
  else
    printf '  %-12s %-42s  \033[32mreachable\033[0m (HTTP %s)\n' "$label" "$url" "$code"
  fi
}

echo ""
echo "Egress probe (reachable = egress allowed; an HTTP 4xx still means reachable):"
echo ""
echo "── Allowlisted on ALL tiers (expect reachable) ──"
probe "Anthropic"  "https://api.anthropic.com/v1/models"
probe "OpenAI"     "https://api.openai.com/v1/models"
probe "GitHub"     "https://github.com"
probe "GitHub raw" "https://raw.githubusercontent.com"
probe "ghcr.io"    "https://ghcr.io"
probe "npm"        "https://registry.npmjs.org"
echo ""
echo "── Cursor (the landmine: .sh hosts NOT on T1/T2 allowlist) ──"
probe "Cursor api" "https://api.cursor.com"
probe "Cursor sh2" "https://api2.cursor.sh"
probe "Cursor sh3" "https://api3.cursor.sh"
probe "Cursor a5"  "https://agent.api5.cursor.sh"
echo ""
echo "If any cursor.sh host is BLOCKED while api.cursor.com is reachable, this box"
echo "is on Tier 1/2 — Cursor agents need Tier 3 (\$500 top-up) per the plan §2.5."
echo ""
