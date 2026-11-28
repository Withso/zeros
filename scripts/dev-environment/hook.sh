#!/bin/sh
set -eu
if [ "${1:-}" = archive ]; then
  exec sh scripts/dev-environment/archive-hook.sh
fi
. ./scripts/dev-environment/toolchain.sh
if [ "${1:-}" = setup ]; then
  zeros_dev_setup_tools
else
  zeros_dev_select_tools
fi
case "${1:-}" in
  setup)
    if [ -f scripts/dev-environment/setup.mjs ]; then
      node scripts/dev-environment/setup.mjs --checkout
    fi
    node scripts/dev-environment/dependencies.mjs --install ;;
  # Zeros Dev is headless; `backend` remains for older Conductor settings.
  dev|backend) exec pnpm electron:cloud ;;
  *) echo 'Unknown Dev hook' >&2; exit 1 ;;
esac
