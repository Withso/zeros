#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────
# start-engine.sh — launch the admitted Zeros engine on a Linux compute provider.
# ──────────────────────────────────────────────────────────
#
# Baked into the zeros-engine-v1 image; invoked by provision.ts as a managed
# session process (so an engine crash ≠ container death). Binds CloudTransport
# on 0.0.0.0:$ZEROS_CLOUD_PORT — the runtime listener reached by the control-plane relay.
#
# Env (injected at sandbox create / by provision.ts):
#   ZEROS_CLOUD_PORT    required — the 0.0.0.0 bridge port (CloudTransport)
#   ZEROS_CLOUD_TOKEN   required — second-layer /ws token
#   ZEROS_CLOUD_OWNER_SUB required — immutable account owner for asymmetric JWT binding
#   ZEROS_DATA_DIR      engine DB + control state (baked default; survives stop)
#   ZEROS_REPO_DIR      writable repo to serve (default /srv/zeros/workspace)
# ──────────────────────────────────────────────────────────
set -euo pipefail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
unset BASH_ENV ENV NODE_OPTIONS NODE_PATH LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD

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

# Bootstrap only from this installed physical script. The shared resolver is
# the sole descriptor reader; neither argv nor environment can select a root.
CLOUD_START_SCRIPT=$(readlink -f -- "${BASH_SOURCE[0]}")
if [[ ! "$CLOUD_START_SCRIPT" =~ ^/opt/zeros-infra/r1-[a-f0-9]{64}/bin/start-engine\.sh$ ]]; then
  echo "[start-engine] FATAL: unsafe installed launcher" >&2
  exit 1
fi
CLOUD_BOOT_ROOT="${CLOUD_START_SCRIPT%/bin/start-engine.sh}"
CLOUD_BOOT_NODE="$CLOUD_BOOT_ROOT/bin/node"
cloud_root_file() {
  local candidate="$1" ancestor="$1"
  [[ -f "$candidate" && ! -L "$candidate" && "$(stat -c '%h' -- "$candidate")" == 1 && "$(readlink -f -- "$candidate")" == "$candidate" ]] || return 1
  while :; do
    [[ ! -L "$ancestor" && "$(stat -c '%u' -- "$ancestor")" == 0 && $((8#$(stat -c '%a' -- "$ancestor") & 8#022)) == 0 ]] || return 1
    [[ "$ancestor" == / ]] && break
    ancestor="$(dirname -- "$ancestor")"
    [[ -d "$ancestor" ]] || return 1
  done
}
cloud_root_file "$CLOUD_START_SCRIPT"
cloud_root_file "$CLOUD_BOOT_NODE"
cloud_root_file "$CLOUD_BOOT_ROOT/lib/zeros/cloud-runtime-root.mjs"
[[ "$(id -u)" == 0 && -x "$CLOUD_BOOT_NODE" ]]
CLOUD_SELECTION=$("$CLOUD_BOOT_NODE" --input-type=module - "$CLOUD_START_SCRIPT" <<'ZEROS_RUNTIME_SELECTION'
import path from "node:path";
import {pathToFileURL} from "node:url";
const installed=process.argv[2], lib=path.join(path.dirname(path.dirname(installed)),"lib/zeros");
const {resolveCloudRuntime}=await import(pathToFileURL(`${lib}/cloud-runtime-root.mjs`));
const runtime=resolveCloudRuntime();
if(runtime.startEngine!==installed || runtime.profile!=="v4" || runtime.node!==process.execPath)
  throw new Error("Cloud launch runtime changed");
const {readCloudHostRuntimeProfile}=await import(pathToFileURL(runtime.helpers.profile));
const profile=readCloudHostRuntimeProfile();
process.stdout.write([runtime.workerRoot,runtime.libRoot,runtime.binRoot,
  runtime.node,String(profile.version)].join("\n"));
ZEROS_RUNTIME_SELECTION
)
mapfile -t CLOUD_PATHS <<< "$CLOUD_SELECTION"
[[ "${#CLOUD_PATHS[@]}" == 5 ]]
ENGINE_DIR="${CLOUD_PATHS[0]}"
RUNTIME_LIB="${CLOUD_PATHS[1]}"
export PATH="${CLOUD_PATHS[2]}:/usr/bin:/bin:/usr/sbin:/sbin"
RUNTIME="${CLOUD_PATHS[3]}"
PROFILE_VERSION="${CLOUD_PATHS[4]}"
unset CLOUD_SELECTION CLOUD_PATHS CLOUD_BOOT_ROOT CLOUD_BOOT_NODE CLOUD_START_SCRIPT
REPO_DIR="${ZEROS_REPO_DIR:-/srv/zeros/workspace}"

LOG="/srv/zeros/log/engine.log"
ENGINE_UID="10003"
ENGINE_GID="10003"
# Physical settings and logs retain the frozen base's traversal group. The
# launcher projects settings for the engine's separate execution identity.
BASE_AGENT_GID="10001"

# Deployment authority is fixed by the image and root-owned marker. Sandbox
# create-time variables may configure the connection and provider credentials,
# but can never redirect a privileged runtime into the writable checkout.
export HOME="/srv/zeros/home/agent"
export USER="zeros-engine"
export LOGNAME="zeros-engine"
export SHELL="/bin/bash"
export ZEROS_DATA_DIR="/srv/zeros/state"
export ZEROS_WORKSPACES_DIR="/srv/zeros/state/workspaces"
export ZEROS_PTY_HOST_RUNTIME="$RUNTIME"
export ZEROS_PTY_HOST_SCRIPT="$ENGINE_DIR/apps/desktop/src/engine/pty/pty-host.cjs"
export ZEROS_CURSOR_HOST_SCRIPT="$ENGINE_DIR/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs"
export ZEROS_RIPGREP_PATH="$ENGINE_DIR/binaries/rg"


if [[ "$PROFILE_VERSION" != "4" ]]; then
  echo "[start-engine] FATAL: unsupported runtime profile" >&2
  exit 1
fi
RUNTIME_DIRECTORY="/run/zeros/engine"
ENGINE_UID="10003"
SETTINGS_DIRECTORY="/srv/zeros/managed-settings"
TEMPLATE_WORKSPACE=0
REPO_DIR=$("$RUNTIME" "$RUNTIME_LIB/cloud-computer-checkout.mjs" --host-repository) || exit 1
if [[ "$REPO_DIR" != "/srv/zeros/files/workspace" ]]; then TEMPLATE_WORKSPACE=1; fi

SETUP_BOOT="${ZEROS_CLOUD_SETUP_BOOT:-}"
if [[ -n "$SETUP_BOOT" && "$SETUP_BOOT" != "1" ]]; then
  echo "[start-engine] FATAL: cloud setup boot marker is invalid" >&2
  exit 1
fi
if [[ "$SETUP_BOOT" == "1" ]]; then
  if [[ -z "${ZEROS_CLOUD_RUNTIME_B64:-}" ]]; then
    echo "[start-engine] FATAL: cloud runtime registration is missing" >&2
    exit 1
  fi
  if [[ ! -S /run/zeros/cloud-worker-supervisor.sock || -L /run/zeros/cloud-worker-supervisor.sock || "$(stat -c '%u:%a' /run/zeros/cloud-worker-supervisor.sock)" != "0:600" ]]; then
    echo "[start-engine] FATAL: cloud worker supervisor is unavailable" >&2
    exit 1
  fi
  if [[ ! -d "$SETTINGS_DIRECTORY" || -L "$SETTINGS_DIRECTORY" || "$(stat -c '%u:%g:%a' "$SETTINGS_DIRECTORY")" != "0:$BASE_AGENT_GID:750" ]]; then
    echo "[start-engine] FATAL: managed cloud settings directory is unsafe" >&2
    exit 1
  fi
  if [[ ! -f ${SETTINGS_DIRECTORY}/settings.managed.toml || -L ${SETTINGS_DIRECTORY}/settings.managed.toml || "$(stat -c '%u:%g:%a:%h' ${SETTINGS_DIRECTORY}/settings.managed.toml)" != "0:$BASE_AGENT_GID:640:1" ]]; then
    echo "[start-engine] FATAL: managed cloud settings are unsafe" >&2
    exit 1
  fi
  export ZEROS_USER_SETTINGS_DIR="$SETTINGS_DIRECTORY"
elif [[ -n "${ZEROS_CLOUD_RUNTIME_B64:-}" ]]; then
  echo "[start-engine] FATAL: cloud runtime registration requires setup boot" >&2
  exit 1
fi


if [[ ! -f "$ENGINE_DIR/dist-engine/cli.js" || -L "$ENGINE_DIR" ]]; then
  echo "[start-engine] FATAL: immutable engine installation is missing" >&2
  exit 1
fi
if [[ ! -x "$RUNTIME_LIB/consume-cloud-admission.mjs" || -L "$RUNTIME_LIB/consume-cloud-admission.mjs" ]]; then
  echo "[start-engine] FATAL: cloud admission verifier is missing" >&2
  exit 1
fi
if [[ ! -x "$RUNTIME_LIB/install-cloud-preview-links.mjs" || -L "$RUNTIME_LIB/install-cloud-preview-links.mjs" ]]; then
  echo "[start-engine] FATAL: cloud preview installer is missing" >&2
  exit 1
fi
if [[ ! -x "$RUNTIME_LIB/install-cloud-github-credential.mjs" || -L "$RUNTIME_LIB/install-cloud-github-credential.mjs" ]]; then
  echo "[start-engine] FATAL: cloud GitHub credential installer is missing" >&2
  exit 1
fi
if [[ ! -x "$RUNTIME_LIB/cloud-github-refresh-request.mjs" || -L "$RUNTIME_LIB/cloud-github-refresh-request.mjs" ]]; then
  echo "[start-engine] FATAL: cloud GitHub refresh request helper is missing" >&2
  exit 1
fi
if [[ ! -d /run/zeros || -L /run/zeros || "$(stat -c '%u:%a' /run/zeros)" != "0:700" ]]; then
  echo "[start-engine] FATAL: root-only runtime directory is unavailable" >&2
  exit 1
fi
if [[ "$SETUP_BOOT" != "1" && ( ! -f ${RUNTIME_DIRECTORY}/cloud-preview-links.json || -L ${RUNTIME_DIRECTORY}/cloud-preview-links.json || "$(stat -c '%u:%a:%h' ${RUNTIME_DIRECTORY}/cloud-preview-links.json)" != "$ENGINE_UID:600:1" ) ]]; then
  echo "[start-engine] FATAL: root-owned cloud preview ingress is unavailable" >&2
  exit 1
fi
if [[ "$TEMPLATE_WORKSPACE" != "1" && ( ! -f ${RUNTIME_DIRECTORY}/github-credential.json || -L ${RUNTIME_DIRECTORY}/github-credential.json || "$(stat -c '%u:%a:%h' ${RUNTIME_DIRECTORY}/github-credential.json)" != "$ENGINE_UID:600:1" ) ]]; then
  echo "[start-engine] FATAL: root-owned cloud GitHub credential projection is unavailable" >&2
  exit 1
fi

# The attester and engine share this lock. This prevents a new qualification
# pass from replacing an admission proof while a coordinator is live, and
# prevents two coordinators from consuming adjacent proofs concurrently.
exec 9>>/run/zeros/engine.lock
if ! /usr/bin/flock --nonblock 9; then
  echo "[start-engine] FATAL: another attester or engine owns this worker" >&2
  exit 1
fi
if [[ "$(stat -c '%u:%a' "$ENGINE_DIR")" != 0:* || $((8#$(stat -c '%a' "$ENGINE_DIR") & 8#022)) -ne 0 ]]; then
  echo "[start-engine] FATAL: engine installation is not root-controlled" >&2
  exit 1
fi
if ! setpriv --reuid="$ENGINE_UID" --regid="$ENGINE_GID" --clear-groups test -w "$REPO_DIR"; then
  echo "[start-engine] FATAL: writable checkout is unavailable to the agent" >&2
  exit 1
fi

# The attester creates a root-only, namespace/container-instance-bound proof.
# Consumption is atomic and one-use, so a parallel or stale launcher cannot
# start the privileged coordinator without completing the live engine lifecycle probes.
"$RUNTIME" "$RUNTIME_LIB/consume-cloud-admission.mjs"

cd "$REPO_DIR"
umask 0002
if [[ ! -e "$LOG" ]]; then
  install -o root -g "$BASE_AGENT_GID" -m 0640 /dev/null "$LOG"
elif [[ -f "$LOG" && ! -L "$LOG" ]]; then
  chown root:"$BASE_AGENT_GID" "$LOG"
  chmod 0640 "$LOG"
else
  echo "[start-engine] FATAL: engine log is not a physical regular file" >&2
  exit 1
fi

echo "[start-engine] runtime=$RUNTIME cloud_port=$ZEROS_CLOUD_PORT data_dir=${ZEROS_DATA_DIR:-<default>} workspace=$REPO_DIR engine=$ENGINE_DIR"
echo "[start-engine] backend=cloud-worker token_gate=on agent=$ENGINE_UID:$ENGINE_GID log=$LOG"

# `serve` binds LocalTransport (127.0.0.1, harmless) AND — because
# ZEROS_CLOUD_PORT is set — CloudTransport on 0.0.0.0:$ZEROS_CLOUD_PORT. Keep
# Node as the direct supervised process. A tee sibling would retain the one-use
# registration material in its inherited environment for the engine lifetime.
exec "$RUNTIME" "$RUNTIME_LIB/cloud-engine-launcher.mjs" >>"$LOG" 2>&1
