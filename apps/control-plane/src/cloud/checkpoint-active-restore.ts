const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const CLOUD_V2_RESTORE_AUTH_PREFIX = "/dev/shm/zeros-restore-auth-";

/** The provider command channel sees this token. Git reads it from tmpfs through
 * askpass, and no checkpoint content exists until the credential is gone. */
export function activeRestoreFetchSteps(token: string | undefined, remote: string): string[] {
  if (!token || !/^[\x21-\x7e]{16,4096}$/.test(token)) throw new Error("Active restore requires a GitHub credential");
  const repository = remote.endsWith(".git") ? remote.slice(0, -4) : remote;
  if (repository.match(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)?.[0] !== repository)
    throw new Error("Active restore requires an explicit GitHub repository");
  return [
    "set +x; set +o history",
    "export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_COUNT=0",
    "unset GIT_CONFIG_PARAMETERS GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "unset GIT_TRACE GIT_TRACE_PACKET GIT_TRACE_CURL GIT_TRACE2 GIT_TRACE2_EVENT GIT_TRACE2_PERF GIT_CURL_VERBOSE",
    "git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c credential.helper= -c protocol.allow=never -c protocol.https.allow=\"$https_allowed\" -c http.followRedirects=false -c http.extraHeader= \"$@\"; }",
    "step=fetch; https_allowed=always",
    "[ ! -L /dev/shm ] && [ \"$(stat -f -c %T /dev/shm)\" = tmpfs ] || fail checkpoint_restore_failed",
    `auth_dir=$(mktemp -d ${quote(`${CLOUD_V2_RESTORE_AUTH_PREFIX}XXXXXXXXXX`)})`,
    "chmod 700 \"$auth_dir\"",
    `printf %s ${quote(Buffer.from(token).toString("base64"))} | base64 -d > "$auth_dir/token"`,
    "chmod 600 \"$auth_dir/token\"",
    "printf '#!/bin/sh\\ncase \"$1\" in Username*) printf \"x-access-token\\\\n\" ;; Password*) cat \"$ZEROS_RESTORE_TOKEN_FILE\" ;; *) exit 1 ;; esac\\n' > \"$work/askpass\"",
    "chmod 700 \"$work/askpass\"",
    "git init -q --bare --template= \"$work/fetched\"",
    `GIT_ALLOW_PROTOCOL=https GIT_ASKPASS="$work/askpass" ZEROS_RESTORE_TOKEN_FILE="$auth_dir/token" git -C "$work/fetched" fetch -q --no-recurse-submodules --no-write-fetch-head ${quote(remote)} '+refs/heads/*:refs/remotes/origin/*' '+refs/tags/*:refs/tags/*' || fail checkpoint_prerequisites_missing`,
    "rm -f -- \"$auth_dir/token\" \"$work/askpass\"; rmdir -- \"$auth_dir\"",
    "[ ! -e \"$auth_dir\" ] && [ ! -L \"$auth_dir\" ] && [ ! -e \"$work/askpass\" ] || fail checkpoint_restore_failed",
    "auth_dir=''; unset GIT_ASKPASS SSH_ASKPASS ZEROS_RESTORE_TOKEN_FILE",
    "https_allowed=never; export GIT_ALLOW_PROTOCOL='' GIT_PROTOCOL_FROM_USER=0",
    "mkdir -p \"$repo\"; [ ! -L \"$repo\" ] || fail checkpoint_restore_failed",
    "rm -rf -- \"$repo/.git\"; mv -- \"$work/fetched\" \"$repo/.git\"",
    "git -C \"$repo\" config core.bare false",
    `git -C "$repo" remote add origin ${quote(remote)}`,
  ];
}
