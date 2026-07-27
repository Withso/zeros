#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# Stage 10 — re-runnable capability probe
# ──────────────────────────────────────────────────────────
#
# Captures the deterministic subset of the agent-capability
# matrix — the parts answerable by shelling out, with no model
# round-trip and no paid quota:
#
#   - which agents are installed + version
#   - resume-flag presence (parsed from --help)
#   - headless smoke ("say hi" → exit code + duration)
#
# Manual / paid-quota tests (project-context, memory, subagent,
# skill, MCP) are out of scope here — they need real model
# round-trips, so they stay a manual pass.
#
# Re-run before every release: `bash scripts/test-agent-capabilities.sh`
# ──────────────────────────────────────────────────────────

set -uo pipefail

AGENTS=(claude codex cursor-agent)
TMP="$(mktemp -d)"
trap "rm -rf '$TMP'" EXIT

echo "Stage 10 capability probe — $(date '+%Y-%m-%d %H:%M:%S')"
echo

# ── Versions ──────────────────────────────────────────────
echo "## Versions"
for cli in "${AGENTS[@]}"; do
  if command -v "$cli" >/dev/null 2>&1; then
    ver=$("$cli" --version 2>&1 | head -1 | tr -d '\n')
    printf "  %-15s %s\n" "$cli" "$ver"
  else
    printf "  %-15s NOT INSTALLED\n" "$cli"
  fi
done
echo

# ── Resume-flag detection ────────────────────────────────
echo "## Resume flags"
detect_resume() {
  local cli=$1
  local out
  # Grep ALL --resume / --continue / -r / `resume ` (codex subcommand)
  # lines, then pick the most informative one. Earlier draft used a
  # too-narrow regex that missed -r prefixes and
  # mis-matched --cloud for Cursor.
  out=$("$cli" --help 2>&1 | grep -iE "(\-\-resume|\-\-continue|^\s*resume\s|\-r,\s\-\-resume)" | head -1)
  if [ -n "$out" ]; then
    echo "$out" | sed 's/^[[:space:]]*//' | head -c 80
  else
    echo "(none in --help)"
  fi
}
for cli in "${AGENTS[@]}"; do
  if command -v "$cli" >/dev/null 2>&1; then
    flag=$(detect_resume "$cli")
    printf "  %-15s %s\n" "$cli" "$flag"
  fi
done
echo

# ── Headless smoke ───────────────────────────────────────
# Each agent needs its own headless invocation. Failure here means
# our adapter's headless flags are wrong (or the agent's defaults
# changed) — it is the single highest-signal probe in this file.
# Re-test on every CLI bump.
echo "## Headless smoke (\"say hi\")"
mkdir -p "$TMP/probe-cwd"
cd "$TMP/probe-cwd"

run_test() {
  local label=$1
  shift
  local start=$(date +%s)
  "$@" > /dev/null 2>"$TMP/$label.err"
  local ec=$?
  local end=$(date +%s)
  local dur=$((end - start))
  if [ $ec -eq 0 ]; then
    printf "  %-15s ✓ %2ss\n" "$label" "$dur"
  else
    printf "  %-15s ✗ exit=%d %2ss — see %s\n" "$label" "$ec" "$dur" "$TMP/$label.err"
  fi
}

if command -v claude >/dev/null 2>&1; then
  run_test claude claude -p "say hi" --output-format json
fi
if command -v codex >/dev/null 2>&1; then
  run_test codex codex exec --skip-git-repo-check --output-last-message "$TMP/codex.out" "say hi"
fi
if command -v cursor-agent >/dev/null 2>&1; then
  run_test cursor cursor-agent -p "say hi" --output-format text --trust --model auto
fi

echo
echo "Done. Re-check the adapter capability flags in src/engine/agents/ if anything regressed."
