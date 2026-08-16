#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# start-engine.sh — launch the Zeros engine inside a Daytona sandbox.
# ──────────────────────────────────────────────────────────
#
# Baked into the zeros-engine-v1 image; invoked by provision.ts as a managed
# session process (so an engine crash ≠ container death). Binds CloudTransport
# on 0.0.0.0:$ZEROS_CLOUD_PORT — the port the Daytona preview URL maps to.
#
# Env (injected at sandbox create / by provision.ts):
#   ZEROS_CLOUD_PORT    required — the 0.0.0.0 bridge port (CloudTransport)
#   ZEROS_CLOUD_TOKEN   required — second-layer /ws token
#   ZEROS_CLOUD_OWNER_SUB required — immutable account owner for asymmetric JWT binding
#   ZEROS_DATA_DIR      engine DB + control state (baked default; survives stop)
#   ZEROS_REPO_DIR      writable repo to serve (default /workspace/zeros)
# ──────────────────────────────────────────────────────────
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD

ENGINE_DIR="/opt/zeros"
REPO_DIR="${ZEROS_REPO_DIR:-/workspace/zeros}"
RUNTIME="node"
LOG="/var/log/zeros/engine.log"
WORKER_UID="10001"
WORKER_GID="10001"

# Deployment authority is fixed by the image and root-owned marker. Sandbox
# create-time variables may configure the connection and provider credentials,
# but can never redirect a privileged runtime into the writable checkout.
export HOME="/home/zeros-agent"
export USER="zeros-agent"
export LOGNAME="zeros-agent"
export SHELL="/bin/bash"
export ZEROS_DATA_DIR="/var/lib/zeros"
export ZEROS_WORKSPACES_DIR="/var/lib/zeros/workspaces"
export ZEROS_PTY_HOST_RUNTIME="/usr/local/bin/node"
export ZEROS_PTY_HOST_SCRIPT="$ENGINE_DIR/apps/desktop/src/engine/pty/pty-host.cjs"
export ZEROS_CURSOR_HOST_SCRIPT="$ENGINE_DIR/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs"
export ZEROS_ZSR_SUPERVISOR_RUNTIME="/usr/local/bin/node"
export ZEROS_ZSR_SUPERVISOR_SCRIPT="$ENGINE_DIR/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs"
export ZEROS_ZSR_NETWORK_BRIDGE_SCRIPT="$ENGINE_DIR/apps/desktop/src/engine/agents/containment/zsr-network-bridge.mjs"
export ZEROS_ZSR_CONTAINER_WORKER_SCRIPT="$ENGINE_DIR/apps/desktop/src/engine/agents/containment/zsr-container-worker.mjs"
export ZEROS_ZSR_BWRAP_PATH="/usr/bin/bwrap"
export ZEROS_ZSR_SOCAT_PATH="/usr/bin/socat"
export ZEROS_ZSR_SETPRIV_PATH="/usr/bin/setpriv"

if [[ -z "${ZEROS_CLOUD_PORT:-}" ]]; then
  echo "[start-engine] FATAL: ZEROS_CLOUD_PORT is not set" >&2
  exit 1
fi
if ! [[ "$ZEROS_CLOUD_PORT" =~ ^[1-9][0-9]{0,4}$ ]]; then
  echo "[start-engine] FATAL: ZEROS_CLOUD_PORT is invalid" >&2
  exit 1
fi
CLOUD_PORT_DECIMAL=$((10#$ZEROS_CLOUD_PORT))
if (( CLOUD_PORT_DECIMAL > 65535 || CLOUD_PORT_DECIMAL == 22222 )); then
  echo "[start-engine] FATAL: ZEROS_CLOUD_PORT is invalid" >&2
  exit 1
fi
unset CLOUD_PORT_DECIMAL
if [[ -z "${ZEROS_CLOUD_TOKEN:-}" ]]; then
  echo "[start-engine] FATAL: ZEROS_CLOUD_TOKEN is not set" >&2
  exit 1
fi
if [[ "$(id -u)" != "0" ]]; then
  echo "[start-engine] FATAL: the cloud coordinator must start as root" >&2
  exit 1
fi
if [[ ! -f /etc/zeros/cloud-worker.json || -L /etc/zeros/cloud-worker.json ]]; then
  echo "[start-engine] FATAL: immutable cloud-worker marker is missing" >&2
  exit 1
fi
if [[ ! -f "$ENGINE_DIR/dist-engine/cli.js" || -L "$ENGINE_DIR" ]]; then
  echo "[start-engine] FATAL: immutable engine installation is missing" >&2
  exit 1
fi
if [[ ! -x /usr/local/lib/zeros/consume-cloud-admission.mjs || -L /usr/local/lib/zeros/consume-cloud-admission.mjs ]]; then
  echo "[start-engine] FATAL: cloud admission verifier is missing" >&2
  exit 1
fi
if [[ ! -x /usr/local/lib/zeros/install-cloud-preview-links.mjs || -L /usr/local/lib/zeros/install-cloud-preview-links.mjs ]]; then
  echo "[start-engine] FATAL: cloud preview installer is missing" >&2
  exit 1
fi
if [[ ! -x /usr/local/lib/zeros/install-cloud-github-credential.mjs || -L /usr/local/lib/zeros/install-cloud-github-credential.mjs ]]; then
  echo "[start-engine] FATAL: cloud GitHub credential installer is missing" >&2
  exit 1
fi
if [[ ! -x /usr/local/lib/zeros/cloud-github-refresh-request.mjs || -L /usr/local/lib/zeros/cloud-github-refresh-request.mjs ]]; then
  echo "[start-engine] FATAL: cloud GitHub refresh request helper is missing" >&2
  exit 1
fi
if [[ ! -d /run/zeros || -L /run/zeros || "$(stat -c '%u:%a' /run/zeros)" != "0:700" ]]; then
  echo "[start-engine] FATAL: root-only runtime directory is unavailable" >&2
  exit 1
fi
if [[ ! -f /run/zeros/cloud-preview-links.json || -L /run/zeros/cloud-preview-links.json || "$(stat -c '%u:%a:%h' /run/zeros/cloud-preview-links.json)" != "0:600:1" ]]; then
  echo "[start-engine] FATAL: root-owned cloud preview ingress is unavailable" >&2
  exit 1
fi
if [[ ! -f /run/zeros/github-credential.json || -L /run/zeros/github-credential.json || "$(stat -c '%u:%a:%h' /run/zeros/github-credential.json)" != "0:600:1" ]]; then
  echo "[start-engine] FATAL: root-owned cloud GitHub credential projection is unavailable" >&2
  exit 1
fi

# The attester and engine share this lock. This prevents a new qualification
# pass from killing/recovering cgroups while an admitted coordinator is live,
# and prevents two coordinators from consuming adjacent proofs concurrently.
exec 9>>/run/zeros/engine.lock
if ! /usr/bin/flock --nonblock 9; then
  echo "[start-engine] FATAL: another attester or engine owns this worker" >&2
  exit 1
fi
if [[ "$(stat -c '%u:%a' "$ENGINE_DIR")" != 0:* || $((8#$(stat -c '%a' "$ENGINE_DIR") & 8#022)) -ne 0 ]]; then
  echo "[start-engine] FATAL: engine installation is not root-controlled" >&2
  exit 1
fi
if ! setpriv --reuid="$WORKER_UID" --regid="$WORKER_GID" --clear-groups test -w "$REPO_DIR"; then
  echo "[start-engine] FATAL: writable checkout is unavailable to the worker" >&2
  exit 1
fi

# The attester creates a root-only, namespace/container-instance-bound proof.
# Consumption is atomic and one-use, so a parallel or stale launcher cannot
# start the privileged coordinator without completing the live ZSR harness.
/usr/local/bin/node /usr/local/lib/zeros/consume-cloud-admission.mjs

cd "$REPO_DIR"
umask 0002
if [[ ! -e "$LOG" ]]; then
  install -o root -g "$WORKER_GID" -m 0640 /dev/null "$LOG"
elif [[ -f "$LOG" && ! -L "$LOG" ]]; then
  chown root:"$WORKER_GID" "$LOG"
  chmod 0640 "$LOG"
else
  echo "[start-engine] FATAL: engine log is not a physical regular file" >&2
  exit 1
fi

echo "[start-engine] runtime=$RUNTIME cloud_port=$ZEROS_CLOUD_PORT data_dir=${ZEROS_DATA_DIR:-<default>} workspace=$REPO_DIR engine=$ENGINE_DIR"
echo "[start-engine] backend=cloud-worker token_gate=on worker=$WORKER_UID:$WORKER_GID log=$LOG"

# `serve` binds LocalTransport (127.0.0.1, harmless) AND — because ZEROS_CLOUD_PORT
# is set — CloudTransport on 0.0.0.0:$ZEROS_CLOUD_PORT. tee so logs are both live
# (the session stream) and durable (for the test client to fetch on failure).
exec node "$ENGINE_DIR/dist-engine/cli.js" serve --root "$REPO_DIR" 2>&1 | tee -a "$LOG"
