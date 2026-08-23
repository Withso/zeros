#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# with-userns — run one command with unprivileged user namespaces permitted
# ──────────────────────────────────────────────────────────
#
# The contained-execution (ZSR) suites nest a second capability-bearing user
# namespace inside bubblewrap. Ubuntu's bwrap AppArmor profile deliberately
# strips those nested capabilities, so the pinned runtime's documented host
# prerequisite is satisfied ONLY for the command passed here and restored the
# moment it returns — a job-wide relaxation would leave every later step
# (including third-party actions) running with the restriction lifted.
#
# Usage: bash scripts/ci/with-userns.sh pnpm test:git
#
# Non-Linux hosts and kernels without the AppArmor knob have nothing to relax,
# so the command is exec'd unchanged. That keeps this safe to call from a matrix
# leg that is not Ubuntu instead of forcing the caller to branch on the runner.
# ──────────────────────────────────────────────────────────
set -euo pipefail

KEY=kernel.apparmor_restrict_unprivileged_userns

if [ "$#" -eq 0 ]; then
  echo "with-userns: no command given" >&2
  echo "usage: bash scripts/ci/with-userns.sh <command> [args...]" >&2
  exit 2
fi

if ! restriction=$(sysctl -n "$KEY" 2>/dev/null); then
  exec "$@"
fi

restore() { sudo sysctl -q -w "$KEY=$restriction"; }
trap restore EXIT

sudo sysctl -q -w "$KEY=0"
applied=$(sysctl -n "$KEY")
if [ "$applied" != "0" ]; then
  # Fail loudly rather than run the suite under a restriction that makes the
  # containment tests fail for an environmental reason, not a real regression.
  echo "with-userns: could not lift $KEY (still '$applied')" >&2
  exit 1
fi

"$@"
