#!/bin/sh
set -eu
if [ "${1:-}" = archive ] && [ "${2:-}" != --receipt-known ]; then
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
      node scripts/dev-environment/setup.mjs --profile-only
    fi
    pnpm install --frozen-lockfile
    pnpm --dir apps/control-plane install --frozen-lockfile
    npm --prefix apps/web ci ;;
  archive)
    if ! node -e 'process.exit(typeof require("./package.json").scripts?.["dev:archive"] === "string" ? 0 : 1)'; then
      echo 'Hosted Dev binding exists but this branch lacks dev:archive. Switch to a branch with dev:archive, then retry; cleanup is unconfirmed.' >&2; exit 1
    fi
    exec pnpm dev:archive ;;
  dev) exec pnpm electron:dev ;;
  backend) exec pnpm dev:backend ;;
  *) echo 'Unknown Dev hook' >&2; exit 1 ;;
esac
