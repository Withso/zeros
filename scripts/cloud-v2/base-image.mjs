#!/usr/bin/env node
// Builds the cloud workspace v2 Boat base image: Boat's stock Ubuntu image plus
// the Zeros worker from one exact commit and its systemd unit, saved as a named
// snapshot. Cloud Computer builds start from it.
//
//   node scripts/cloud-v2/base-image.mjs --name zeros-v2-base-1 --commit <sha> --github-token-file <file>
//
// Boat credentials come from BOAT_API_KEY and BOAT_BILLING_ORG (or .env.agent).
// The GitHub token must be short-lived and read-only; it is used once inside the
// builder for the clone and is never written to the image.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const name = arg("--name"), commit = arg("--commit"), tokenFile = arg("--github-token-file");
const repository = arg("--repository") ?? "withso/zeros";
if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(name ?? "")) throw new Error("--name must be a Boat snapshot name");
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit must be a full commit SHA that is pushed");
if (!tokenFile) throw new Error("--github-token-file is required");

function credentials() {
  const fromFile = existsSync(path.join(root, ".env.agent")) ? Object.fromEntries(readFileSync(path.join(root, ".env.agent"), "utf8")
    .split("\n").filter(line => line.includes("=") && !line.startsWith("#"))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim().replace(/^"|"$/g, "")])) : {};
  const apiKey = process.env.BOAT_API_KEY ?? fromFile.BOAT_API_KEY, billingOrg = process.env.BOAT_BILLING_ORG ?? fromFile.BOAT_BILLING_ORG;
  if (!apiKey) throw new Error("BOAT_API_KEY is required");
  return { apiKey, billingOrg };
}
const boat = credentials();
const githubToken = readFileSync(tokenFile, "utf8").trim();

async function call(method, route, body, headers = {}) {
  const response = await fetch(`https://boat.dev/api/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${boat.apiKey}`, accept: "application/json", "content-type": "application/json",
      ...(boat.billingOrg ? { "x-boat-org": boat.billingOrg } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Boat ${method} ${route.split("/").slice(0, 3).join("/")} failed: ${response.status} ${data?.error?.code ?? data?.code ?? ""}`);
  return data;
}
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const log = message => console.log(`[cloud-v2-base] ${message}`);

async function exec(sandboxId, label, command, timeoutSeconds = 900) {
  const result = await call("POST", `/sandboxes/${sandboxId}/commands`, { command: `bash -lc ${quote(command)}`, timeoutSeconds });
  const tail = String(result.stdout ?? "").split("\n").slice(-12).join("\n");
  if (result.exitCode !== 0 || result.timedOut) throw new Error(`${label} failed (exit ${result.exitCode}${result.timedOut ? ", timed out" : ""})\n${tail}`);
  log(`${label}: ok`);
  return String(result.stdout ?? "");
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
Environment=PATH=/opt/zeros/worker/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env node /opt/zeros/worker/worker.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

async function main() {
  const created = await call("POST", "/sandboxes", {
    type: "default", name: `zeros-v2-base-build-${commit.slice(0, 8)}`, ttlSeconds: 7200, monitoring: false, env: {},
  }, { "idempotency-key": `zeros-v2-base-${name}-${commit}` });
  const sandboxId = created.sandbox.id;
  log(`builder ${sandboxId}`);
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = (await call("GET", `/sandboxes/${sandboxId}`)).sandbox?.state;
    if (state === "idle" || state === "running") break;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  const node = (await exec(sandboxId, "check stock tools",
    "set -e; sudo -n true; node -e 'if (+process.versions.node.split(\".\")[0] < 24) process.exit(1)'; command -v node git gh rg; id -un")).trim();
  log(node.split("\n").join(" "));
  const auth = Buffer.from(`x-access-token:${githubToken}`).toString("base64");
  await exec(sandboxId, "fetch source", [
    "set -e", "rm -rf /tmp/zeros-src && mkdir -p /tmp/zeros-src && cd /tmp/zeros-src && git init -q",
    `git -c ${quote(`http.extraHeader=Authorization: Basic ${auth}`)} fetch -q --depth 1 ${quote(`https://github.com/${repository}.git`)} ${commit}`,
    "git checkout -q FETCH_HEAD",
  ].join("\n"), 600);
  await exec(sandboxId, "build worker", [
    "set -e", "cd /tmp/zeros-src", "sudo -n corepack enable pnpm",
    "pnpm install --frozen-lockfile --filter @zeros/cloud-worker...",
    "pnpm --filter @zeros/cloud-worker build",
    "test -f apps/cloud-worker/dist/worker.mjs",
  ].join("\n"), 1800);
  await exec(sandboxId, "install worker", [
    "set -e", "sudo -n rm -rf /opt/zeros/worker && sudo -n mkdir -p /opt/zeros/worker",
    "sudo -n cp -a /tmp/zeros-src/apps/cloud-worker/dist/. /opt/zeros/worker/",
    `printf %s ${quote(JSON.stringify({ commit, repository, builtAt: new Date().toISOString() }))} | sudo -n tee /opt/zeros/worker/BUILD.json >/dev/null`,
    "sudo -n chown -R root:root /opt/zeros && sudo -n chmod -R a+rX,go-w /opt/zeros",
    `printf %s ${quote(UNIT)} | sudo -n tee /etc/systemd/system/zeros-worker.service >/dev/null`,
    "sudo -n systemctl daemon-reload && sudo -n systemctl enable zeros-worker.service",
    // Nothing from the build checkout, package caches or shell history stays.
    "rm -rf /tmp/zeros-src ~/.cache/pnpm ~/.local/share/pnpm ~/.npm && history -c",
  ].join("\n"), 600);
  await call("POST", `/sandboxes/${sandboxId}/stop`);
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = (await call("GET", `/sandboxes/${sandboxId}`)).sandbox?.state;
    if (state === "stopped" || state === "archived") break;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  await call("POST", "/named-snapshots", { sandboxId, name });
  for (let attempt = 0; attempt < 200; attempt++) {
    const snapshot = (await call("GET", `/named-snapshots/${name}`)).snapshot;
    if (snapshot?.status === "ready") { log(`ready: ${name} (builder ${sandboxId} backs it; keep it)`); return; }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error("The named snapshot did not become ready");
}

main().catch(error => { console.error(`[cloud-v2-base] ${error instanceof Error ? error.message : "failed"}`); process.exitCode = 1; });
