#!/usr/bin/env bash
# Retry a network install a runner's DNS or mirror blip can fail, e.g.
# "Temporary failure resolving 'archive.ubuntu.com'" during apt or Playwright.
# Usage: bash scripts/ci/retry.sh <command> [args...]
# Three attempts with 15 s and 30 s pauses (CI_RETRY_DELAY_SECONDS overrides
# the base pause). Exits with the last attempt's status.
set -uo pipefail
if [ "$#" -eq 0 ]; then
  echo "usage: retry.sh <command> [args...]" >&2
  exit 2
fi
attempts=3
delay="${CI_RETRY_DELAY_SECONDS:-15}"
for attempt in $(seq 1 "$attempts"); do
  "$@"
  status=$?
  if [ "$status" -eq 0 ]; then exit 0; fi
  if [ "$attempt" -eq "$attempts" ]; then
    echo "::error::$1 failed $attempts times (last status $status)." >&2
    exit "$status"
  fi
  echo "::warning::Attempt $attempt/$attempts failed (status $status); retrying in $(( delay * attempt )) s." >&2
  sleep $(( delay * attempt ))
done
