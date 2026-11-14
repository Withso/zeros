// The worker runtime: the cloud worker bundle with the agents' binaries, kept
// in object storage by its sha256. Like Conductor's runtime, a VM downloads the
// version the control plane names, caches it by that sha256 and runs it, so
// shipping a new worker never needs an image rebuild. Cloud Computer builds
// cache the current runtime in the org snapshot, so a new workspace rarely
// downloads anything.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPublicKey } from "node:crypto";
import { runtimeTimingScript } from "./runtime-timing.js";
import { runtimeVerificationScript } from "./runtime-verification.js";

const SHA256 = /^[0-9a-f]{64}$/;
const URL_TTL_SECONDS = 15 * 60;
const RUNTIMES = "/opt/zeros/runtime";
/** The stable path the unit, PATH and the worker's own wrappers use. */
const CURRENT = "/opt/zeros/worker";
const COMPILE_CACHE = "/home/user/.cache/zeros/node-compile-cache";

export type CloudV2RuntimeStore = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
/** The pinned runtime. `url` presigns it, or another published runtime by its sha256. */
export type CloudV2Runtime = { sha256: string; url(sha256?: string): Promise<string>; supportedSha256?: readonly string[] };

export const cloudV2RuntimeKey = (sha256: string) => `cloud-v2/runtime/${sha256}.tar.gz`;

export function cloudV2Runtime(sha256: string, store: CloudV2RuntimeStore, supportedSha256?: readonly string[]): CloudV2Runtime {
  if (!SHA256.test(sha256)) throw new Error("Invalid runtime sha256");
  const pins = supportedPins({ sha256, ...(supportedSha256 ? { supportedSha256 } : {}) });
  const client = new S3Client({
    region: "auto", endpoint: store.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey },
  });
  return {
    sha256, supportedSha256: pins,
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
ConditionPathExists=/run/zeros-worker.boot

[Service]
Type=simple
User=user
WorkingDirectory=/home/user
EnvironmentFile=-/home/user/.config/zeros/worker.env
EnvironmentFile=-/opt/zeros/worker-runtime.env
Environment=PATH=${CURRENT}/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/zeros/start-worker
Restart=always
RestartSec=2
OOMPolicy=continue

[Install]
WantedBy=multi-user.target
`;
// Agents' login shells use the same git and gh wrappers as the service.
const PROFILE = `export PATH="${CURRENT}/bin:$PATH"\n`;

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const verifyFunction = `runtime_verify() { env -u NODE_OPTIONS -u NODE_PATH NODE_DISABLE_COMPILE_CACHE=1 node -e ${quote(runtimeVerificationScript)} "$@"; }`;
const START_SCRIPT = [
  "#!/bin/bash", "set -eu",
  'test "$(cat /run/zeros-worker.boot)" = "$(cat /proc/sys/kernel/random/boot_id)"',
  `dir=$(readlink ${CURRENT}); sha256=\${dir##*/}`,
  'test "$sha256" = "$CLOUD_V2_RUNTIME_SHA256"',
  'grep -Fxq -- "$sha256" /opt/zeros/worker-supported',
  verifyFunction,
  'runtime_verify "$dir" "$sha256"',
  `export NODE_COMPILE_CACHE=${COMPILE_CACHE}/$sha256`,
  'exec /usr/bin/env node "$dir/worker.mjs"',
].join("\n") + "\n";

function supportedPins(runtime: { sha256: string; supportedSha256?: readonly string[] }): readonly string[] {
  const pins = runtime.supportedSha256 ?? [runtime.sha256];
  if (!pins.length || pins.length > 3 || pins[0] !== runtime.sha256 || new Set(pins).size !== pins.length || pins.some(pin => !SHA256.test(pin)))
    throw new Error("Invalid supported runtime pins");
  return pins;
}

/** Selection never starts a process. Token delivery admits this machine boot;
 * the unit rechecks the selected artifact immediately before execution. */
export function installRuntimeCommand(runtime: { sha256: string; url: string; publicKeys?: readonly string[];
  supportedSha256?: readonly string[]; timeoutSeconds?: number }): string {
  const pins = supportedPins(runtime), prepare = runtimePreparation(runtime);
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const keys = runtime.publicKeys;
  if (keys && (!keys.length || keys.length > 4 || keys.some(key => key.length > 4096 || createPublicKey(key).asymmetricKeyType !== "ed25519")))
    throw new Error("Invalid worker verification keys");
  const seconds = runtime.timeoutSeconds ?? 300;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error("Invalid runtime install deadline");
  const script = [
    "set -eu", ...runtimeTimingScript, verifyFunction, "runtime_begin verify", "selected=",
    `for candidate in ${pins.join(" ")}; do`,
    `  if runtime_verify ${RUNTIMES}/$candidate "$candidate"; then selected=$candidate; break; fi`,
    "done",
    'if [ -z "$selected" ]; then',
    ...prepare,
    `  selected=${runtime.sha256}`,
    "fi",
    `dir=${RUNTIMES}/$selected`,
    "runtime_begin cache",
    `unit=$(printf %s ${quote(b64(UNIT))} | base64 -d)`,
    `profile=$(printf %s ${quote(b64(PROFILE))} | base64 -d)`,
    `start=$(printf %s ${quote(b64(START_SCRIPT))} | base64 -d)`,
    `supported=$(printf %s ${quote(b64(pins.join("\n")))} | base64 -d)`,
    ...(keys ? [`keys=$(printf %s ${quote(b64(JSON.stringify(keys)))} | base64 -d)`] : []),
    `if [ "$(readlink ${CURRENT} 2>/dev/null || true)" = "$dir" ] && ` +
      '[ "$(cat /etc/systemd/system/zeros-worker.service 2>/dev/null || true)" = "$unit" ] && ' +
      '[ "$(cat /etc/profile.d/zeros-worker.sh 2>/dev/null || true)" = "$profile" ] && ' +
      '[ "$(cat /opt/zeros/start-worker 2>/dev/null || true)" = "$start" ] && ' +
      '[ "$(cat /opt/zeros/worker-supported 2>/dev/null || true)" = "$supported" ]' +
      (keys ? ' && [ "$(cat /opt/zeros/worker-auth.json 2>/dev/null || true)" = "$keys" ]' : "") +
      '; then echo "runtime-selected $selected"; exit 0; fi',
    "runtime_begin activate",
    `sudo -n mkdir -p ${RUNTIMES}`,
    `sudo -n touch ${RUNTIMES}/.install.lock && sudo -n chmod 0644 ${RUNTIMES}/.install.lock`,
    `exec 9<${RUNTIMES}/.install.lock; flock -x 9`,
    'runtime_verify "$dir" "$selected"',
    ...(keys ? [
      'if [ "$(cat /opt/zeros/worker-auth.json 2>/dev/null || true)" != "$keys" ]; then',
      '  printf %s "$keys" | sudo -n tee /opt/zeros/worker-auth.json.next >/dev/null',
      "  sudo -n chown root:root /opt/zeros/worker-auth.json.next; sudo -n chmod 0644 /opt/zeros/worker-auth.json.next; sudo -n mv -T /opt/zeros/worker-auth.json.next /opt/zeros/worker-auth.json",
      "fi",
    ] : []),
    'if [ "$(cat /etc/systemd/system/zeros-worker.service 2>/dev/null || true)" != "$unit" ]; then',
    '  printf "%s\\n" "$unit" | sudo -n tee /etc/systemd/system/zeros-worker.service >/dev/null',
    "  sudo -n systemctl daemon-reload && sudo -n systemctl enable zeros-worker.service >/dev/null 2>&1",
    "fi",
    'if [ "$(cat /etc/profile.d/zeros-worker.sh 2>/dev/null || true)" != "$profile" ]; then',
    '  printf "%s\\n" "$profile" | sudo -n tee /etc/profile.d/zeros-worker.sh >/dev/null', "fi",
    'if [ "$(cat /opt/zeros/start-worker 2>/dev/null || true)" != "$start" ]; then',
    '  printf "%s\\n" "$start" | sudo -n tee /opt/zeros/start-worker.next >/dev/null',
    "  sudo -n chown root:root /opt/zeros/start-worker.next; sudo -n chmod 0755 /opt/zeros/start-worker.next; sudo -n mv -T /opt/zeros/start-worker.next /opt/zeros/start-worker", "fi",
    'if [ "$(cat /opt/zeros/worker-supported 2>/dev/null || true)" != "$supported" ]; then',
    '  printf "%s\\n" "$supported" | sudo -n tee /opt/zeros/worker-supported.next >/dev/null',
    "  sudo -n chown root:root /opt/zeros/worker-supported.next; sudo -n chmod 0644 /opt/zeros/worker-supported.next; sudo -n mv -T /opt/zeros/worker-supported.next /opt/zeros/worker-supported", "fi",
    `previous=$(readlink ${CURRENT} 2>/dev/null || true)`,
    'if [ "$previous" != "$dir" ]; then',
    '  if [ -n "$previous" ]; then sudo -n ln -sfn "$previous" /opt/zeros/worker-previous; fi',
    `  if [ -e ${CURRENT} ] && [ ! -L ${CURRENT} ]; then sudo -n rm -rf ${CURRENT}; fi`,
    `  sudo -n ln -sfn "$dir" ${CURRENT}.next && sudo -n mv -T ${CURRENT}.next ${CURRENT}`,
    "  echo runtime-changed", "fi",
    'echo "runtime-selected $selected"',
  ].join("\n");
  return `timeout --signal=TERM --kill-after=1 ${seconds}s bash -c ${quote(script)}`;
}

/** Preparation cannot move the active link or touch the unit's credentials. */
export function prepareRuntimeCommand(runtime: { sha256: string; url: string; timeoutSeconds?: number }): string {
  const seconds = runtime.timeoutSeconds ?? 300;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error("Invalid runtime preparation deadline");
  return `timeout --signal=TERM --kill-after=1 ${seconds}s bash -c ${quote(["set -eu", ...runtimeTimingScript, verifyFunction, ...runtimePreparation(runtime)].join("\n"))}`;
}

function runtimePreparation(runtime: { sha256: string; url: string }): string[] {
  if (!SHA256.test(runtime.sha256)) throw new Error("Invalid runtime sha256");
  const url = new URL(runtime.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid runtime URL");
  const dir = `${RUNTIMES}/${runtime.sha256}`;
  return [
    "runtime_begin lock",
    `sudo -n mkdir -p ${RUNTIMES}`,
    `sudo -n touch ${RUNTIMES}/.prepare-${runtime.sha256}.lock && sudo -n chmod 0644 ${RUNTIMES}/.prepare-${runtime.sha256}.lock`,
    `exec 8<${RUNTIMES}/.prepare-${runtime.sha256}.lock; flock -x 8`,
    `dir=${dir}`, "runtime_begin cache",
    `if ! runtime_verify "$dir" ${runtime.sha256}; then`,
    '  tmp=$(mktemp -d); runtime_tmp=$tmp; runtime_partial=$dir.partial',
    "  runtime_begin download",
    `  curl -fsS --retry 1 --retry-delay 1 --connect-timeout 5 --max-time 300 -o "$tmp/runtime.tar.gz" ${quote(url.href)}`,
    "  runtime_begin verify",
    `  printf '%s  %s\\n' ${runtime.sha256} "$tmp/runtime.tar.gz" | sha256sum -c --status`,
    "  runtime_begin unpack",
    '  sudo -n rm -rf "$dir.partial" && sudo -n mkdir -p "$dir.partial"',
    '  sudo -n tar -xzf "$tmp/runtime.tar.gz" -C "$dir.partial" --no-same-owner',
    '  sudo -n chown -R root:root "$dir.partial" && sudo -n chmod -R a+rX,go-w "$dir.partial"',
    `  runtime_verify "$dir.partial" ${runtime.sha256} "$tmp/runtime.tar.gz"`,
    "  runtime_begin publish",
    `  sudo -n touch ${RUNTIMES}/.install.lock && sudo -n chmod 0644 ${RUNTIMES}/.install.lock`,
    `  exec 9<${RUNTIMES}/.install.lock; flock -x 9`,
    `  if runtime_verify "$dir" ${runtime.sha256} "$tmp/runtime.tar.gz"; then`,
    '    sudo -n cp "$tmp/runtime.tar.gz" "$dir/.runtime.tar.gz.next"',
    '    sudo -n chmod 0644 "$dir/.runtime.tar.gz.next"; sudo -n mv -T "$dir/.runtime.tar.gz.next" "$dir/.runtime.tar.gz"',
    "  else",
    '    sudo -n cp "$tmp/runtime.tar.gz" "$dir.partial/.runtime.tar.gz"; sudo -n chmod 0644 "$dir.partial/.runtime.tar.gz"',
    '    sudo -n touch "$dir.partial/.complete" && sudo -n rm -rf "$dir" && sudo -n mv "$dir.partial" "$dir"',
    "  fi",
    `  current=$(readlink ${CURRENT} 2>/dev/null || true); previous=$(readlink /opt/zeros/worker-previous 2>/dev/null || true)`,
    `  for old in ${RUNTIMES}/*; do [ "$old" = "$dir" ] || [ "$old" = "$current" ] || [ "$old" = "$previous" ] || sudo -n rm -rf "$old"; done`,
    "  flock -u 9; exec 9<&-",
    "fi",
    "flock -u 8; exec 8<&-", "runtime_end ok",
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
