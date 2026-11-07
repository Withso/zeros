// The worker runtime: the cloud worker bundle with the agents' binaries, kept
// in object storage by its sha256. Like Conductor's runtime, a VM downloads the
// version the control plane names, caches it by that sha256 and runs it, so
// shipping a new worker never needs an image rebuild. Cloud Computer builds
// cache the current runtime in the org snapshot, so a new workspace rarely
// downloads anything.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPublicKey } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;
const URL_TTL_SECONDS = 15 * 60;
const RUNTIMES = "/opt/zeros/runtime";
/** The stable path the unit, PATH and the worker's own wrappers use. */
const CURRENT = "/opt/zeros/worker";

export type CloudV2RuntimeStore = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
/** The pinned runtime. `url` presigns it, or another published runtime by its sha256. */
export type CloudV2Runtime = { sha256: string; url(sha256?: string): Promise<string> };

export const cloudV2RuntimeKey = (sha256: string) => `cloud-v2/runtime/${sha256}.tar.gz`;

export function cloudV2Runtime(sha256: string, store: CloudV2RuntimeStore): CloudV2Runtime {
  if (!SHA256.test(sha256)) throw new Error("Invalid runtime sha256");
  const client = new S3Client({
    region: "auto", endpoint: store.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey },
  });
  return {
    sha256,
    url: async (target = sha256) => {
      if (!SHA256.test(target)) throw new Error("Invalid runtime sha256");
      return getSignedUrl(client, new GetObjectCommand({ Bucket: store.bucket, Key: cloudV2RuntimeKey(target) }), { expiresIn: URL_TTL_SECONDS });
    },
  };
}

const UNIT = `[Unit]
Description=Zeros cloud workspace worker
After=network-online.target
Wants=network-online.target
# The control plane writes the credential after boot and then starts the unit.
ConditionPathExists=/home/user/.config/zeros/worker-token
ConditionPathExists=/opt/zeros/worker-auth.json

[Service]
Type=simple
User=user
WorkingDirectory=/home/user
EnvironmentFile=-/home/user/.config/zeros/worker.env
EnvironmentFile=-/opt/zeros/worker-runtime.env
Environment=PATH=${CURRENT}/bin:/usr/local/bin:/usr/bin:/bin
# Compiled code persists on the VM disk, so a resumed worker skips most parsing.
Environment=NODE_COMPILE_CACHE=/home/user/.cache/zeros/node-compile-cache
ExecStart=/usr/bin/env node ${CURRENT}/worker.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
// Agents' login shells use the same git and gh wrappers as the service.
const PROFILE = `export PATH="${CURRENT}/bin:$PATH"\n`;

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** Installs the runtime if this VM does not have it, points the worker at it
 * and restarts a running worker onto it. Prints `runtime-changed` when it
 * switched versions. Root owns the runtime, so agents cannot modify it. */
export function installRuntimeCommand(runtime: { sha256: string; url: string; publicKeys?: readonly string[] }): string {
  const prepare = runtimePreparation(runtime);
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const keys = runtime.publicKeys;
  if (keys && (!keys.length || keys.length > 4 || keys.some(key => key.length > 4096 || createPublicKey(key).asymmetricKeyType !== "ed25519")))
    throw new Error("Invalid worker verification keys");
  const keysJson = keys ? JSON.stringify(keys) : null;
  const script = [
    "set -eu",
    // A resumed VM usually has everything already. Comparing first skips the
    // lock, the download check and every privileged rewrite on a slow restored disk.
    `unit=$(printf %s ${quote(b64(UNIT))} | base64 -d)`,
    `profile=$(printf %s ${quote(b64(PROFILE))} | base64 -d)`,
    ...(keysJson ? [`keys=$(printf %s ${quote(b64(keysJson))} | base64 -d)`] : []),
    `if [ -f ${RUNTIMES}/${runtime.sha256}/.complete ] && [ "$(readlink ${CURRENT} 2>/dev/null || true)" = ${RUNTIMES}/${runtime.sha256} ] \\`,
    "  && [ ! -e /opt/zeros/worker-runtime.env ] \\",
    '  && [ "$(cat /etc/systemd/system/zeros-worker.service 2>/dev/null || true)" = "$unit" ] \\',
    '  && [ "$(cat /etc/profile.d/zeros-worker.sh 2>/dev/null || true)" = "$profile" ]'
      + (keysJson ? ' \\\n  && [ "$(cat /opt/zeros/worker-auth.json 2>/dev/null || true)" = "$keys" ]' : "") + "; then exit 0; fi",
    ...prepare,
    "sudo -n rm -f /opt/zeros/worker-runtime.env",
    ...(keys ? [
      `printf %s ${quote(b64(JSON.stringify(keys)))} | base64 -d | sudo -n tee /opt/zeros/worker-auth.json.next >/dev/null`,
      "sudo -n chown root:root /opt/zeros/worker-auth.json.next && sudo -n chmod 0644 /opt/zeros/worker-auth.json.next && sudo -n mv -T /opt/zeros/worker-auth.json.next /opt/zeros/worker-auth.json",
    ] : []),
    `if [ "$(cat /etc/systemd/system/zeros-worker.service 2>/dev/null)" != "$unit" ]; then`,
    `  printf '%s\\n' "$unit" | sudo -n tee /etc/systemd/system/zeros-worker.service >/dev/null`,
    "  sudo -n systemctl daemon-reload && sudo -n systemctl enable zeros-worker.service >/dev/null 2>&1",
    "fi",
    `printf %s ${quote(b64(PROFILE))} | base64 -d | sudo -n tee /etc/profile.d/zeros-worker.sh >/dev/null`,
    `previous=$(readlink ${CURRENT} 2>/dev/null || true)`,
    `if [ "$previous" != "$dir" ]; then`,
    `  if [ -n "$previous" ]; then sudo -n ln -sfn "$previous" /opt/zeros/worker-previous; fi`,
    `  if [ -e ${CURRENT} ] && [ ! -L ${CURRENT} ]; then sudo -n rm -rf ${CURRENT}; fi`,
    `  sudo -n ln -sfn "$dir" ${CURRENT}.next && sudo -n mv -T ${CURRENT}.next ${CURRENT}`,
    "  sudo -n systemctl try-restart zeros-worker.service || true",
    `  for old in ${RUNTIMES}/*; do [ "$old" = "$dir" ] || [ "$old" = "$previous" ] || sudo -n rm -rf "$old"; done`,
    "  echo runtime-changed",
    "fi",
  ].join("\n");
  return `bash -c ${quote(script)}`;
}

/** Preparation cannot move the active link or touch the unit's credentials. */
export function prepareRuntimeCommand(runtime: { sha256: string; url: string }): string {
  return `bash -c ${quote(runtimePreparation(runtime).join("\n"))}`;
}

function runtimePreparation(runtime: { sha256: string; url: string }): string[] {
  if (!SHA256.test(runtime.sha256)) throw new Error("Invalid runtime sha256");
  const url = new URL(runtime.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid runtime URL");
  const dir = `${RUNTIMES}/${runtime.sha256}`;
  return [
    "set -eu",
    `sudo -n mkdir -p ${RUNTIMES}`,
    `sudo -n touch ${RUNTIMES}/.install.lock && sudo -n chmod 0644 ${RUNTIMES}/.install.lock`,
    `exec 9<${RUNTIMES}/.install.lock; flock -x 9`,
    `dir=${dir}`,
    `if [ ! -f "$dir/.complete" ]; then`,
    `  tmp=$(mktemp -d); trap 'rm -rf "$tmp"; sudo -n rm -rf "$dir.partial"' EXIT`,
    `  curl -fsS --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 300 -o "$tmp/runtime.tar.gz" ${quote(url.href)}`,
    `  printf '%s  %s\\n' ${runtime.sha256} "$tmp/runtime.tar.gz" | sha256sum -c --status`,
    `  sudo -n rm -rf "$dir.partial" && sudo -n mkdir -p "$dir.partial"`,
    `  sudo -n tar -xzf "$tmp/runtime.tar.gz" -C "$dir.partial" --no-same-owner`,
    `  sudo -n chown -R root:root "$dir.partial" && sudo -n chmod -R a+rX,go-w "$dir.partial"`,
    `  sudo -n touch "$dir.partial/.complete" && sudo -n rm -rf "$dir" && sudo -n mv "$dir.partial" "$dir"`,
    "fi",
    `current=$(readlink ${CURRENT} 2>/dev/null || true); previous=$(readlink /opt/zeros/worker-previous 2>/dev/null || true)`,
    `for old in ${RUNTIMES}/*; do [ "$old" = "$dir" ] || [ "$old" = "$current" ] || [ "$old" = "$previous" ] || sudo -n rm -rf "$old"; done`,
  ];
}

export function activateRuntimeCommand(input: { sha256: string; previousSha256: string; id: string; bootId: string; instanceId: string;
  tokenSha256: string; expectedBootIds: readonly string[]; rollback?: boolean }): string {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (![input.sha256, input.previousSha256, input.tokenSha256].every(value => SHA256.test(value)) ||
      ![input.id, input.bootId, input.instanceId, ...input.expectedBootIds].every(value => uuid.test(value)) ||
      !input.expectedBootIds.length || input.expectedBootIds.length > 3) throw new Error("Invalid runtime handoff");
  const environment = `CLOUD_V2_RUNTIME_SHA256=${input.sha256}\nZEROS_RUNTIME_HANDOFF=${input.id}\nZEROS_RUNTIME_BOOT=${input.bootId}\nZEROS_RUNTIME_INSTANCE=${input.instanceId}\n`;
  const marker = `/opt/zeros/runtime-activation-${input.id}-${input.bootId}`;
  const permits = "/home/user/.local/share/zeros/cloud-worker/runtime-handoffs";
  return `bash -c ${quote([
    "set -eu",
    `exec 9<${RUNTIMES}/.install.lock; flock -x 9`,
    `test -f ${RUNTIMES}/${input.sha256}/.complete`,
    `current=$(readlink ${CURRENT})`,
    `test "$current" = ${RUNTIMES}/${input.previousSha256} || test "$current" = ${RUNTIMES}/${input.sha256}`,
    // The marker precedes restart. An uncertain provider reply may inspect it,
    // but must not restart the same boot again and consume its one-use identity.
    `if [ -f ${marker} ]; then echo activation-recorded; exit 0; fi`,
    `printf %s ${quote(Buffer.from(environment).toString("base64"))} | base64 -d | sudo -n tee /opt/zeros/worker-runtime.env.next >/dev/null`,
    "sudo -n chown root:root /opt/zeros/worker-runtime.env.next && sudo -n chmod 0644 /opt/zeros/worker-runtime.env.next",
    `test "$(sha256sum /home/user/.config/zeros/worker-token | cut -d ' ' -f 1)" = ${input.tokenSha256}`,
    `boot=$(cat /home/user/.local/share/zeros/cloud-worker/runtime-boot)`,
    input.expectedBootIds.map(boot => `test "$boot" = ${boot}`).join(" || "),
    ...(input.rollback ? [`test -f ${permits}/consumed-${input.id}`] : [
      `mv -T ${permits}/permit-${input.id}-${input.expectedBootIds[0]} ${permits}/consumed-${input.id}`,
    ]),
    "sudo -n mv -T /opt/zeros/worker-runtime.env.next /opt/zeros/worker-runtime.env",
    `sudo -n ln -sfn ${RUNTIMES}/${input.previousSha256} /opt/zeros/worker-previous`,
    `sudo -n ln -sfn ${RUNTIMES}/${input.sha256} ${CURRENT}.next && sudo -n mv -T ${CURRENT}.next ${CURRENT}`,
    `sudo -n touch ${marker}`,
    `sync -f /opt/zeros; sync -f ${permits}`,
    "sudo -n systemctl restart zeros-worker.service",
    "echo activation-recorded",
  ].join("\n"))}`;
}

export function pruneRuntimeCommand(current: string, previous: string): string {
  if (![current, previous].every(value => SHA256.test(value))) throw new Error("Invalid runtime pins");
  return `bash -c ${quote(["set -eu", `exec 9<${RUNTIMES}/.install.lock; flock -x 9`, `test "$(readlink ${CURRENT})" = ${RUNTIMES}/${current}`,
    `for old in ${RUNTIMES}/*; do [ "$old" = ${RUNTIMES}/${current} ] || [ "$old" = ${RUNTIMES}/${previous} ] || sudo -n rm -rf "$old"; done`].join("\n"))}`;
}

export function completeRuntimeCommand(input: { id: string; bootId: string; instanceId: string; sha256: string; previousSha256: string; tokenSha256: string }): string {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (![input.id, input.bootId, input.instanceId].every(value => uuid.test(value)) ||
      ![input.sha256, input.previousSha256, input.tokenSha256].every(value => SHA256.test(value))) throw new Error("Invalid runtime completion.");
  const root = "/home/user/.local/share/zeros/cloud-worker/runtime-handoffs";
  const environment = `CLOUD_V2_RUNTIME_SHA256=${input.sha256}\nZEROS_RUNTIME_HANDOFF=${input.id}\nZEROS_RUNTIME_BOOT=${input.bootId}\nZEROS_RUNTIME_INSTANCE=${input.instanceId}`;
  return `bash -c ${quote([
    "set -eu", `exec 9<${RUNTIMES}/.install.lock; flock -x 9`,
    `test "$(readlink ${CURRENT})" = ${RUNTIMES}/${input.sha256}`,
    `test "$(sha256sum /home/user/.config/zeros/worker-token | cut -d ' ' -f 1)" = ${input.tokenSha256}`,
    `override=$(cat /opt/zeros/worker-runtime.env 2>/dev/null || true)`,
    `if [ "$override" = ${quote(environment)} ]; then`,
    `  mkdir -p ${root}; touch ${root}/completed-${input.id}-${input.bootId}; sync -f ${root}`,
    `  printf '%s\\n' CLOUD_V2_RUNTIME_SHA256=${input.sha256} | sudo -n tee /opt/zeros/worker-runtime.env.next >/dev/null`,
    "  sudo -n chown root:root /opt/zeros/worker-runtime.env.next; sudo -n chmod 0644 /opt/zeros/worker-runtime.env.next",
    "  sudo -n mv -T /opt/zeros/worker-runtime.env.next /opt/zeros/worker-runtime.env; sync -f /opt/zeros",
    `else test -z "$override" || test "$override" = CLOUD_V2_RUNTIME_SHA256=${input.sha256}; fi`,
    `for old in ${RUNTIMES}/*; do [ "$old" = ${RUNTIMES}/${input.sha256} ] || [ "$old" = ${RUNTIMES}/${input.previousSha256} ] || sudo -n rm -rf "$old"; done`,
    `for old in ${root}/* /opt/zeros/runtime-activation-*; do case "$old" in *${input.id}*) ;; *) sudo -n rm -f "$old" ;; esac; done`,
  ].join("\n"))}`;
}

/** Revocation shares activation's lock and consumes no runtime. An ambiguous
 * provider reply can repeat this observation without another restart. */
export function retireRuntimePermitCommand(id: string, bootId: string): string {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (![id, bootId].every(value => uuid.test(value))) throw new Error("Invalid runtime handoff.");
  const root = "/home/user/.local/share/zeros/cloud-worker/runtime-handoffs";
  return `bash -c ${quote(["set -eu", `exec 9<${RUNTIMES}/.install.lock; flock -x 9`,
    `if [ -f ${root}/consumed-${id} ]; then echo started; else rm -f ${root}/permit-${id}-${bootId}; echo not-started; fi`].join("\n"))}`;
}
