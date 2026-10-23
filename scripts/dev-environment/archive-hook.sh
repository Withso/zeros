#!/bin/sh
set -eu
# Embedded verbatim in shared Conductor/native settings so an old branch can
# discover absence without this file, Node, pnpm, or the new package scripts.
# Local cloud state predates the hosted owner binding and uses the launcher's
# root-checked derived identity. Never discover or reset another instance.
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
if [ ! -e .context/zeros-dev/owner.json ] && [ ! -L .context/zeros-dev/owner.json ]; then
  zeros_dev_probe_profile=${ZEROS_DEV_PROFILE_PATH:-}
  if [ -z "$zeros_dev_probe_profile" ]; then
    for zeros_dev_candidate in "$PWD/zeros-dev-env.json" "$PWD/.env.zeros-dev.json" "$HOME/.zeros-dev/zeros-dev-env.json" "$HOME/.zeros-dev/development.json"; do
      if [ -e "$zeros_dev_candidate" ] || [ -L "$zeros_dev_candidate" ]; then zeros_dev_probe_profile=$zeros_dev_candidate; break; fi
    done
  fi
  if [ -z "$zeros_dev_probe_profile" ] && [ -z "${ZEROS_DEV_PROFILE_B64:-}" ]; then
    echo 'No hosted Dev binding or provisioning profile in this checkout; nothing to clean.'; exit 0
  fi
  # Pre-binding legacy receipts still need a read-only check. System Python's
  # standard library suffices; no qualified Node or installed dependencies.
  if ! command -v python3 >/dev/null 2>&1; then
    echo 'Legacy Dev ownership cannot be checked without system Python 3. Use dev:doctor --all from a current checkout before confirming cleanup.' >&2; exit 1
  fi
  zeros_dev_probe_status=0
  python3 - "$zeros_dev_probe_profile" <<'ZEROS_DEV_REGISTRY_PROBE' || zeros_dev_probe_status=$?
import base64, datetime, hashlib, hmac, json, os, re, stat, sys, urllib.error, urllib.request

def probe(profile_path, request_head=None):
    if profile_path:
        details = os.lstat(profile_path)
        if not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid() or details.st_mode & 0o077 or details.st_size > 131072:
            raise ValueError("private profile required")
        with open(profile_path, "r") as source:
            config = json.load(source).get("registry")
    else:
        encoded = os.environ.get("ZEROS_DEV_PROFILE_B64", "")
        if not encoded or len(encoded) > 174764:
            raise ValueError("bounded cloud profile required")
        decoded = base64.b64decode(encoded, validate=True)
        if len(decoded) > 131072 or base64.b64encode(decoded).decode() != encoded:
            raise ValueError("invalid cloud profile encoding")
        profile = json.loads(decoded)
        config = profile.get("registry")
        if profile.get("version") != 2 or profile.get("mode") != "hosted" or not config:
            raise ValueError("hosted cloud profile required")
    if not config:
        return 0  # The old Local profile has no hosted registry authority.
    endpoint, bucket = config.get("endpoint", ""), config.get("bucket", "")
    if not re.fullmatch(r"https://[a-f0-9]{32}\.r2\.cloudflarestorage\.com", endpoint) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket) or "dev" not in bucket:
        raise ValueError("unexpected registry scope")
    access, secret = config.get("accessKeyId"), config.get("secretAccessKey")
    if not isinstance(access, str) or not access or not isinstance(secret, str) or not secret:
        raise ValueError("missing registry authority")
    def head(key):
        if request_head:
            return request_head(key)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        day, host = stamp[:8], endpoint[8:]
        uri, empty = "/" + bucket + ("/" + key if key else ""), hashlib.sha256(b"").hexdigest()
        headers = "host:" + host + "\nx-amz-content-sha256:" + empty + "\nx-amz-date:" + stamp + "\n"
        names = "host;x-amz-content-sha256;x-amz-date"
        canonical = "HEAD\n" + uri + "\n\n" + headers + "\n" + names + "\n" + empty
        scope = day + "/auto/s3/aws4_request"
        signing = ("AWS4" + secret).encode()
        for value in [day, "auto", "s3", "aws4_request"]:
            signing = hmac.new(signing, value.encode(), hashlib.sha256).digest()
        signature = hmac.new(signing, ("AWS4-HMAC-SHA256\n" + stamp + "\n" + scope + "\n" + hashlib.sha256(canonical.encode()).hexdigest()).encode(), hashlib.sha256).hexdigest()
        request = urllib.request.Request(endpoint + uri, method="HEAD", headers={"x-amz-date": stamp, "x-amz-content-sha256": empty,
            "authorization": "AWS4-HMAC-SHA256 Credential=" + access + "/" + scope + ", SignedHeaders=" + names + ", Signature=" + signature})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, hdrs, newurl):
                return None
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=3) as response:
                return response.status
        except urllib.error.HTTPError as error:
            error.close()
            return error.code
    if head("") != 200:
        raise ValueError("registry authentication unconfirmed")
    root = os.path.realpath(os.getcwd())
    candidates = {"checkout:" + root}
    uuid = r"[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}"
    for prefix, key, root_key in [("zeros", "ZEROS_WORKSPACE_CANONICAL_ID", "ZEROS_WORKSPACE_ROOT"), ("conductor", "CONDUCTOR_WORKSPACE_ID", "CONDUCTOR_WORKSPACE_PATH")]:
        value, bound_root = os.environ.get(key, ""), os.environ.get(root_key, "")
        if re.fullmatch(uuid, value) and bound_root and os.path.realpath(bound_root) == root:
            candidates.add(prefix + ":" + value.lower())
    name = os.path.basename(root)
    if re.fullmatch(uuid, name) and os.path.basename(os.path.dirname(os.path.dirname(root))) == "remote-workspace-sync":
        candidates.add("conductor:" + name.lower())
    for identity in sorted(candidates):
        owner = hashlib.sha256(identity.encode()).hexdigest()[:24]
        status = head("environments/v1/" + owner + ".json")
        if status == 200:
            return 10
        if status != 404:
            raise ValueError("registry receipt lookup unconfirmed")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(probe(sys.argv[1]))
    except Exception:
        print("Legacy hosted Dev receipt lookup is unconfirmed; use dev:doctor --all from a current checkout. No cleanup was assumed.", file=sys.stderr)
        sys.exit(1)
ZEROS_DEV_REGISTRY_PROBE
  if [ "$zeros_dev_probe_status" = 0 ]; then
    echo 'No hosted Dev binding or registry receipt for this checkout; nothing to clean.'; exit 0
  fi
  if [ "$zeros_dev_probe_status" != 10 ]; then exit "$zeros_dev_probe_status"; fi
fi
if [ ! -f scripts/dev-environment/hook.sh ]; then
  echo 'Hosted Dev receipt/binding exists but this branch lacks dev:archive. Switch to a branch with dev:archive, then retry; cleanup is unconfirmed.' >&2; exit 1
fi
exec sh scripts/dev-environment/hook.sh archive --receipt-known
