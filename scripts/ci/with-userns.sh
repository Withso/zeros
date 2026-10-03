#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# with-userns — run one command with unprivileged user namespaces permitted
# ──────────────────────────────────────────────────────────
#
# The contained-execution (ZSR) suites nest a second capability-bearing user
# namespace inside bubblewrap. Ubuntu restricts those nested capabilities with
# a sysctl and, on 26.04, an independently enforced bwrap AppArmor profile. The
# pinned runtime's documented host prerequisite is satisfied ONLY for the
# command passed here; both controls are restored when it returns. Production
# image policy is separate and is never changed by this CI helper.
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

BWRAP_APPARMOR_PROFILE=/etc/apparmor.d/bwrap-userns-restrict
restore_bwrap_profile=0
restore() {
  local restore_status=0
  if [ "$restore_bwrap_profile" = "1" ]; then
    sudo apparmor_parser --replace --skip-cache "$BWRAP_APPARMOR_PROFILE" || restore_status=$?
  fi
  # Restore the sysctl even when restoring the profile failed. Either failure
  # must fail the step, including after an otherwise successful test command.
  sudo sysctl -q -w "$KEY=$restriction" || restore_status=$?
  return "$restore_status"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if sudo test -f "$BWRAP_APPARMOR_PROFILE"; then
  loaded_profiles=$(sudo cat /sys/kernel/security/apparmor/profiles)
  if printf '%s\n' "$loaded_profiles" | grep -qx 'bwrap (enforce)' &&
     printf '%s\n' "$loaded_profiles" | grep -qx 'unpriv_bwrap (enforce)'; then
    # The 26.04 profile stacks unpriv_bwrap on every bwrap child and explicitly
    # denies capabilities, independently of the sysctl. Keep --cap-drop ALL in
    # the runtime; suspend only this extra host restriction for the test.
    # Mark restoration first because the parser may fail after partial removal.
    restore_bwrap_profile=1
    sudo apparmor_parser --remove --skip-cache "$BWRAP_APPARMOR_PROFILE"
  elif printf '%s\n' "$loaded_profiles" | grep -Eq '^(bwrap|unpriv_bwrap) \('; then
    echo "with-userns: unexpected bwrap AppArmor state; refusing to change it" >&2
    exit 1
  fi
fi

sudo sysctl -q -w "$KEY=0"
applied=$(sysctl -n "$KEY")
if [ "$applied" != "0" ]; then
  # Fail loudly rather than run the suite under a restriction that makes the
  # containment tests fail for an environmental reason, not a real regression.
  echo "with-userns: could not lift $KEY (still '$applied')" >&2
  exit 1
fi

"$@"
