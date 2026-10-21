// The worker runtime: the cloud worker bundle with the agents' binaries, kept
// in object storage by its sha256. Like Conductor's runtime, a VM downloads the
// version the control plane names, caches it by that sha256 and runs it, so
// shipping a new worker never needs an image rebuild. Cloud Computer builds
// cache the current runtime in the org snapshot, so a new workspace rarely
// downloads anything.
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const SHA256 = /^[0-9a-f]{64}$/;
const URL_TTL_SECONDS = 15 * 60;
const RUNTIMES = "/opt/zeros/runtime";
/** The stable path the unit, PATH and the worker's own wrappers use. */
const CURRENT = "/opt/zeros/worker";

export type CloudV2RuntimeStore = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };
export type CloudV2Runtime = { sha256: string; url(): Promise<string> };

export const cloudV2RuntimeKey = (sha256: string) => `cloud-v2/runtime/${sha256}.tar.gz`;

export function cloudV2Runtime(sha256: string, store: CloudV2RuntimeStore): CloudV2Runtime {
  if (!SHA256.test(sha256)) throw new Error("Invalid runtime sha256");
  const client = new S3Client({
    region: "auto", endpoint: store.endpoint, forcePathStyle: true,
    credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey },
  });
  return {
    sha256,
    url: () => getSignedUrl(client, new GetObjectCommand({ Bucket: store.bucket, Key: cloudV2RuntimeKey(sha256) }), { expiresIn: URL_TTL_SECONDS }),
  };
}

const UNIT = `[Unit]
Description=Zeros cloud workspace worker
After=network-online.target
Wants=network-online.target
# The control plane writes the credential after boot and then starts the unit.
ConditionPathExists=/home/user/.config/zeros/worker-token

[Service]
Type=simple
User=user
WorkingDirectory=/home/user
EnvironmentFile=-/home/user/.config/zeros/worker.env
Environment=PATH=${CURRENT}/bin:/usr/local/bin:/usr/bin:/bin
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
export function installRuntimeCommand(runtime: { sha256: string; url: string }): string {
  if (!SHA256.test(runtime.sha256)) throw new Error("Invalid runtime sha256");
  const url = new URL(runtime.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid runtime URL");
  const dir = `${RUNTIMES}/${runtime.sha256}`;
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const script = [
    "set -eu",
    `dir=${dir}`,
    `if [ ! -f "$dir/.complete" ]; then`,
    `  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT`,
    `  curl -fsS --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 300 -o "$tmp/runtime.tar.gz" ${quote(url.href)}`,
    `  printf '%s  %s\\n' ${runtime.sha256} "$tmp/runtime.tar.gz" | sha256sum -c --status`,
    `  sudo -n rm -rf "$dir.partial" && sudo -n mkdir -p "$dir.partial"`,
    `  sudo -n tar -xzf "$tmp/runtime.tar.gz" -C "$dir.partial" --no-same-owner`,
    `  sudo -n chown -R root:root "$dir.partial" && sudo -n chmod -R a+rX,go-w "$dir.partial"`,
    `  sudo -n touch "$dir.partial/.complete" && sudo -n rm -rf "$dir" && sudo -n mv "$dir.partial" "$dir"`,
    "fi",
    `unit=$(printf %s ${quote(b64(UNIT))} | base64 -d)`,
    `if [ "$(cat /etc/systemd/system/zeros-worker.service 2>/dev/null)" != "$unit" ]; then`,
    `  printf '%s\\n' "$unit" | sudo -n tee /etc/systemd/system/zeros-worker.service >/dev/null`,
    "  sudo -n systemctl daemon-reload && sudo -n systemctl enable zeros-worker.service >/dev/null 2>&1",
    "fi",
    `printf %s ${quote(b64(PROFILE))} | base64 -d | sudo -n tee /etc/profile.d/zeros-worker.sh >/dev/null`,
    `if [ "$(readlink ${CURRENT} 2>/dev/null || true)" != "$dir" ]; then`,
    `  if [ -e ${CURRENT} ] && [ ! -L ${CURRENT} ]; then sudo -n rm -rf ${CURRENT}; fi`,
    `  sudo -n ln -sfn "$dir" ${CURRENT}.next && sudo -n mv -T ${CURRENT}.next ${CURRENT}`,
    "  sudo -n systemctl try-restart zeros-worker.service || true",
    `  for old in ${RUNTIMES}/*; do [ "$old" = "$dir" ] || sudo -n rm -rf "$old"; done`,
    "  echo runtime-changed",
    "fi",
  ].join("\n");
  return `bash -c ${quote(script)}`;
}
