#!/bin/bash
# This entrypoint also works before Node or pnpm exists on a new Mac.
set +x
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash scripts/setup-zeros-dev.sh [--profile /path/to/zeros-dev-env.json]
       bash scripts/setup-zeros-dev.sh --check [--profile /path/to/zeros-dev-env.json]
       bash scripts/setup-zeros-dev.sh --profile-only --profile /path/to/zeros-dev-env.json

Installs the macOS development tools and locked repository dependencies, and
imports one private profile into this checkout, its main clone and ~/.zeros-dev.
--check is read-only; --profile-only imports using an already installed Node.
Setup does not provision billable services. Run pnpm electron:dev afterward.
USAGE
}

setup_mode=install
setup_profile_seen=0
parse_setup_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h) usage; exit 0 ;;
      --check|--profile-only)
        [ "$setup_mode" = install ] || { usage >&2; exit 1; }
        setup_mode="$1"; shift ;;
      --profile)
        [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || { usage >&2; exit 1; }
        [ "$setup_profile_seen" = 0 ] || { usage >&2; exit 1; }
        setup_profile_seen=1
        shift 2 ;;
      *) usage >&2; exit 1 ;;
    esac
  done
}
# Preserve the original positional parameters. Empty arrays under nounset fail
# in macOS Bash 3.2; "$@" safely forwards both zero and multiple arguments.
parse_setup_args "$@"

setup_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [ "$setup_mode" != --profile-only ] && { [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; }; then
  echo 'Desktop setup requires an Apple silicon Mac. Linux can use --profile-only and pnpm dev:backend.' >&2
  exit 1
fi
if [ "$(id -u)" = 0 ]; then
  echo 'Run Dev setup as your normal user, without sudo.' >&2; exit 1
fi

. "$setup_root/scripts/dev-environment/toolchain.sh"
node_ready() { zeros_dev_select_tools 2>/dev/null; }

if [ "$setup_mode" = install ]; then
  if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find clang >/dev/null 2>&1; then
    xcode-select --install || true
    echo 'Complete the Apple Command Line Tools installer, then rerun this command.' >&2
    exit 1
  fi
  if ! node_ready || ! command -v python3 >/dev/null 2>&1; then
    if ! command -v brew >/dev/null 2>&1; then
      echo 'Installing Homebrew. macOS may request administrator authentication.'
      setup_installer="$(mktemp -t zeros-homebrew)"
      trap 'rm -f -- "$setup_installer"' EXIT
      curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
        https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "$setup_installer"
      /bin/bash "$setup_installer"
      rm -f -- "$setup_installer"
      trap - EXIT
      export PATH="/opt/homebrew/bin:$PATH"
    fi
    if ! node_ready; then
      brew install node@22
      export PATH="$(brew --prefix node@22)/bin:$PATH"
    fi
    if ! command -v python3 >/dev/null 2>&1; then brew install python; fi
  fi
fi

if ! zeros_dev_select_tools; then
  echo 'Node is missing. Run setup without --check or --profile-only to install it.' >&2; exit 1
fi
export ZEROS_DEV_SETUP_NODE_BIN="$(dirname -- "$(command -v node)")"
exec node "$setup_root/scripts/dev-environment/setup.mjs" "$@"
