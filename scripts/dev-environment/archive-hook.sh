#!/bin/sh
set -eu
# Embedded verbatim in shared Conductor/native settings so an old branch can
# discover absence without this file, Node, pnpm, or the new package scripts.
# Local cloud state uses the launcher's root-checked derived identity. Never
# discover or reset another instance.
zeros_cloud_local_state() {
  python3 - "${1:-}" <<'ZEROS_CLOUD_LOCAL_PROBE'
import hashlib, json, os, re, stat, sys

try:
    root = os.path.realpath(os.getcwd())
    uuid = r"[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}"
    identity = None
    for prefix, key, root_key in [("zeros", "ZEROS_WORKSPACE_CANONICAL_ID", "ZEROS_WORKSPACE_ROOT"), ("conductor", "CONDUCTOR_WORKSPACE_ID", "CONDUCTOR_WORKSPACE_PATH")]:
        value, bound_root = os.environ.get(key, ""), os.environ.get(root_key, "")
        if re.fullmatch(uuid, value) and bound_root and os.path.exists(bound_root) and os.path.realpath(bound_root) == root:
            identity = prefix + ":" + value.lower()
            break
    if identity is None:
        name = os.path.basename(root)
        identity = "conductor:" + name.lower() if re.fullmatch(uuid, name) and os.path.basename(os.path.dirname(os.path.dirname(root))) == "remote-workspace-sync" else "checkout:" + root
    owner = hashlib.sha256(identity.encode()).hexdigest()[:24]
    directory = os.path.realpath(os.path.expanduser("~"))
    for name in [".zeros-dev", "environments", owner]:
        directory = os.path.join(directory, name)
        try:
            details = os.lstat(directory)
        except FileNotFoundError:
            if sys.argv[1]:
                raise ValueError("missing cleanup receipt")
            sys.exit(0)
        if not stat.S_ISDIR(details.st_mode) or details.st_uid != os.getuid() or details.st_mode & (0o022 if name == ".zeros-dev" else 0o077):
            raise ValueError("private state directory required")
    try:
        fd = os.open(os.path.join(directory, "workspace.json"), os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        if sys.argv[1]:
            raise ValueError("missing cleanup receipt")
        sys.exit(0)
    with os.fdopen(fd, "r") as source:
        details = os.fstat(source.fileno())
        if not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid() or details.st_mode & 0o077 or details.st_size > 131072:
            raise ValueError("private bounded receipt required")
        state = json.load(source)
    if state.get("version") != 1 or state.get("owner") != owner or state.get("identity") != identity or not re.fullmatch(uuid, state.get("instanceId", "")) or state.get("status") not in ["active", "archiving", "archived"]:
        raise ValueError("invalid local ownership receipt")
    if sys.argv[1] and (state["instanceId"] != sys.argv[1] or state["status"] != "archived"):
        raise ValueError("cleanup is unconfirmed")
    if state["status"] == "archived":
        sys.exit(0)
    print(state["instanceId"])
    sys.exit(10)
except Exception:
    print("Local cloud cleanup is unconfirmed; preserve its state and retry pnpm electron:cloud --reset --yes from a current branch.", file=sys.stderr)
    sys.exit(1)
ZEROS_CLOUD_LOCAL_PROBE
}
if [ -e "$HOME/.zeros-dev/environments" ] || [ -L "$HOME/.zeros-dev/environments" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo 'Local cloud ownership cannot be checked without system Python 3; cleanup is unconfirmed.' >&2; exit 1
  fi
  zeros_cloud_local_status=0
  zeros_cloud_local_instance=$(zeros_cloud_local_state) || zeros_cloud_local_status=$?
  if [ "$zeros_cloud_local_status" = 10 ]; then
    if [ ! -f scripts/electron-cloud.mjs ] || [ ! -f scripts/dev-environment/toolchain.sh ] || [ ! -f package.json ]; then
      echo 'Local cloud state exists but this branch lacks electron:cloud. Switch to a current branch and run pnpm electron:cloud --reset --yes; cleanup is unconfirmed.' >&2; exit 1
    fi
    . ./scripts/dev-environment/toolchain.sh
    zeros_dev_select_tools
    if ! node -e 'process.exit(require("./package.json").scripts?.["electron:cloud"] ? 0 : 1)' >/dev/null 2>&1; then
      echo 'This branch lacks electron:cloud; local cloud cleanup is unconfirmed.' >&2; exit 1
    fi
    pnpm electron:cloud --reset --yes
    # Exit zero alone is insufficient: the same instance must retain positive
    # proof that its provider drain and local cleanup completed.
    zeros_cloud_local_state "$zeros_cloud_local_instance" >/dev/null
  elif [ "$zeros_cloud_local_status" != 0 ]; then
    exit "$zeros_cloud_local_status"
  fi
fi
