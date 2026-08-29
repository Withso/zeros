#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# egress-probe.sh — verify required outbound endpoints.
# ──────────────────────────────────────────────────────────
#
# Runs inside the sandbox (driven by egress.ts). Provider egress policy can vary
# by account and configuration. This prints a reachable/BLOCKED table for every
# endpoint required by the bundled agent and repository integrations.
#
# Classification: ANY HTTP response (even 401/403/404) ⇒ the host is REACHABLE
# (egress allowed). A connect timeout / refusal / DNS failure ⇒ BLOCKED.
# ──────────────────────────────────────────────────────────
set -uo pipefail

failures=0

probe() {
  local label="$1" url="$2"
  # -s silent, -o /dev/null, -w status, fail fast on connect, cap total time.
  local code
  if ! code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 6 --max-time 12 "$url" 2>/dev/null); then
    code="000"
  fi
  if [[ ! "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
    printf '  %-12s %-42s  \033[31mBLOCKED\033[0m (no HTTP response)\n' "$label" "$url"
    failures=$((failures + 1))
  else
    printf '  %-12s %-42s  \033[32mreachable\033[0m (HTTP %s)\n' "$label" "$url" "$code"
  fi
}

echo ""
echo "Egress probe (reachable = egress allowed; an HTTP 4xx still means reachable):"
echo ""
echo "── Core provider and package endpoints ──"
probe "Anthropic"  "https://api.anthropic.com/v1/models"
probe "OpenAI"     "https://api.openai.com/v1/models"
probe "GitHub"     "https://github.com"
probe "GitHub raw" "https://raw.githubusercontent.com"
probe "ghcr.io"    "https://ghcr.io"
probe "npm"        "https://registry.npmjs.org"
echo ""
echo "── Cursor runtime endpoints ──"
probe "Cursor api" "https://api.cursor.com"
probe "Cursor sh2" "https://api2.cursor.sh"
probe "Cursor sh3" "https://api3.cursor.sh"
probe "Cursor a5"  "https://agent.api5.cursor.sh"
echo ""
echo "If an endpoint is BLOCKED, choose a provider egress policy that permits it"
echo "before enabling that integration in a remote workspace."
echo ""

if (( failures > 0 )); then
  printf '\033[31mEgress qualification failed: %d required endpoint(s) were blocked.\033[0m\n' "$failures"
  exit 1
fi

printf '\033[32mEgress qualification passed: every required endpoint returned HTTP.\033[0m\n'
