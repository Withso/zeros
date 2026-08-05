#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# start-engine.sh — launch the Zeros engine inside a Daytona sandbox.
# ──────────────────────────────────────────────────────────
#
# Baked into the zeros-engine-v0 image; invoked by provision.ts as a managed
# session process (so an engine crash ≠ container death). Binds CloudTransport
# on 0.0.0.0:$ZEROS_CLOUD_PORT — the port the Daytona preview URL maps to.
#
# Env (injected at sandbox create / by provision.ts):
#   ZEROS_CLOUD_PORT    required — the 0.0.0.0 bridge port (CloudTransport)
#   ZEROS_CLOUD_TOKEN   optional — second-layer /ws token (recommended)
#   ZEROS_DATA_DIR      engine DB + workspaces (baked default; survives stop)
#   ZEROS_ENGINE_RUNTIME  node (default) | bun
#   ZEROS_REPO_DIR      repo to serve (default /home/daytona/zeros)
# ──────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="${ZEROS_REPO_DIR:-/home/daytona/zeros}"
RUNTIME="${ZEROS_ENGINE_RUNTIME:-node}"
LOG="${ZEROS_ENGINE_LOG:-/home/daytona/engine.log}"

if [[ -z "${ZEROS_CLOUD_PORT:-}" ]]; then
  echo "[start-engine] FATAL: ZEROS_CLOUD_PORT is not set" >&2
  exit 1
fi

cd "$REPO_DIR"

echo "[start-engine] runtime=$RUNTIME cloud_port=$ZEROS_CLOUD_PORT data_dir=${ZEROS_DATA_DIR:-<default>} repo=$REPO_DIR"
echo "[start-engine] token_gate=$([[ -n "${ZEROS_CLOUD_TOKEN:-}" ]] && echo on || echo off)  log=$LOG"

# `serve` binds LocalTransport (127.0.0.1, harmless) AND — because ZEROS_CLOUD_PORT
# is set — CloudTransport on 0.0.0.0:$ZEROS_CLOUD_PORT. tee so logs are both live
# (the session stream) and durable (for the test client to fetch on failure).
if [[ "$RUNTIME" == "bun" ]]; then
  exec bun "$REPO_DIR/apps/desktop/src/cli.ts" serve --root "$REPO_DIR" 2>&1 | tee -a "$LOG"
else
  exec node "$REPO_DIR/dist-engine/cli.js" serve --root "$REPO_DIR" 2>&1 | tee -a "$LOG"
fi
