# Cloud Workspaces — Phase 1 spike (Daytona snapshot + load-tests)

An operator runbook for the Phase 1 cloud-workspaces spike: prove that a remote
sandbox can boot the Zeros engine and serve a real bridge session, and measure
the numbers (resume latency, socket stability, egress reachability) that the
later phases are sized against.

The exit criterion the scripts here drive:

> a sandbox boots the engine; a desktop test client dials `wss://{port}-{id}.proxy.daytona.work` + token, completes a bridge handshake + `file.tree` + PTY round-trip; survives a `stop()`/`start()` reconnect.

**Status — read this first.** This directory is exploratory harness code, not
product code. The engine change it exercises (`CloudTransport`) ships; these
scripts do not — nothing in the packaged app imports them, and they are excluded
from every build. Running them requires a **Daytona account + API key**, so the
end-to-end runbook below has never been executed in CI and should be treated as
untested-in-anger. It is kept in the tree because it is the only written record
of how the cloud path was meant to be provisioned and measured.

---

## What already landed in the engine (no Daytona needed)

The spike rides a **minimal `CloudTransport`** ([`src/engine/transport/cloud.ts`](../../src/engine/transport/cloud.ts)) — the engine binds a SECOND server on `0.0.0.0:$ZEROS_CLOUD_PORT` with raised `keepAliveTimeout`/`headersTimeout` (Daytona proxy idle-reset [#3846](https://github.com/daytonaio/daytona/issues/3846)) + server-side keepalive pings + an optional `?token=` gate, surfacing peers as `kind: "cloud"`. It is **env-gated** (`ZEROS_CLOUD_PORT`) so it is inert in the desktop build, and **LocalTransport is untouched** (its loopback gate is a DNS-rebinding defense — do not relax it). Per-user JWT auth + account binding is a later phase; today a cloud peer is ungated exactly like local while `accountAuth` is unset.

**Local sanity check (no Daytona):**

```bash
pnpm build:engine
ZEROS_CLOUD_PORT=39393 ZEROS_CLOUD_TOKEN=test node dist-engine/cli.js serve --root .
# in another shell — the cloud bridge is reachable over 0.0.0.0:
curl localhost:39393/health           # → {"status":"ok","transport":"cloud",...}
```

Unit coverage: `src/engine/transport/__tests__/cloud-transport.test.ts` (`pnpm test:git`).

---

## Prerequisites

```bash
export DAYTONA_API_KEY=dtn_...        # required — from https://app.daytona.io
export DAYTONA_TARGET=eu              # optional — us | eu (default eu; no Asia region)
```

The Daytona SDK is already a devDependency (`@daytona/sdk`, pinned). Run each script with `pnpm tsx scripts/cloud-spike/<name>.ts`.

---

## Runbook (in order)

| #   | Command                                                       | What it does                                                                                                                                                        | Measures                    |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | `pnpm tsx scripts/cloud-spike/bake-snapshot.ts`               | Build + register the `zeros-engine-v0` snapshot (clones + builds the engine in-box; **several minutes**).                                                           | image build                 |
| 2   | `pnpm tsx scripts/cloud-spike/provision.ts`                   | Create a sandbox (autoStop:0, never-delete), inject the cloud port + a minted token, start the engine, wait for `/health`, write `.context/cloud-spike/state.json`. | —                           |
| 3   | `pnpm tsx scripts/cloud-spike/test-client.ts`                 | **The exit criterion**: handshake + `file.tree` + PTY round-trip, then `stop()`/`start()` reconnect. (`ZEROS_SPIKE_SKIP_RECONNECT=1` to skip step 4.)               | cold-boot + reconnect       |
| 4   | `pnpm tsx scripts/cloud-spike/egress.ts`                      | Run `egress-probe.sh` in the box → reachable/BLOCKED table incl. the Cursor `*.cursor.sh` landmine.                                                                 | outbound allowlist          |
| 5   | `pnpm tsx scripts/cloud-spike/lifecycle.ts`                   | Time `stopped→start` vs `archived→restore` (resume latency; sets the resume-UX thresholds).                                                                         | resume latency              |
| 6   | `ZEROS_SOAK_HOURS=4 pnpm tsx scripts/cloud-spike/soak-wss.ts` | Hold the bridge open, ping every 25 s, log drops/reconnects/longest-gap.                                                                                            | socket stability            |
| 7   | `pnpm tsx scripts/cloud-spike/ssh-forward.ts`                 | Open `ssh -L` to the cloud port, curl the forwarded `/health`.                                                                                                      | SSH fallback path           |
| —   | `pnpm tsx scripts/cloud-spike/lifecycle.ts --delete`          | Tear the box down (stop billing).                                                                                                                                   | cleanup                     |

### What the scripts cover vs. leave manual

- **Automated:** soak/socket stability, resume latency, cold boot (inside `test-client` step 4), egress (incl. Cursor), `ssh -L`.
- **Still manual:** file-mirror-in-sandbox (needs the Phase 3 mirror), week-long idle billing (read the provider usage dashboard), multi-client WSS (point two `test-client`s at one box), stuck-state reconciliation (needs the reconciler worker), license terms in writing, and fork/runtime-snapshot (not in v1).

After running, **record the numbers** (resume latencies, soak drops, the Cursor egress verdict) so the phases they gate build on measured reality rather than guesses.

---

## Files

| File                                                                                                                     | Role                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                                                                                                              | Shared config (Daytona client, snapshot/port/resource constants, `.context/cloud-spike/state.json` I/O, URL builders). |
| `image.ts`                                                                                                               | The `zeros-engine-v0` Daytona `Image` build spec (canonical; the bake script consumes it).                             |
| `Dockerfile`                                                                                                             | Portable equivalent of `image.ts` (for `Image.fromDockerfile()` / `docker build` / a provider swap).                   |
| `sandbox/start-engine.sh`                                                                                                | In-box engine launcher (binds CloudTransport on 0.0.0.0; node by default, `ZEROS_ENGINE_RUNTIME=bun` to switch).       |
| `sandbox/egress-probe.sh`                                                                                                | In-box curl probe of the agent/git/npm/Cursor hosts.                                                                   |
| `lib/bridge-client.ts`                                                                                                   | Minimal Node client for the Zeros bridge protocol (handshake / `WORKSPACE_REQUEST` / PTY).                             |
| `bake-snapshot.ts` · `provision.ts` · `test-client.ts` · `egress.ts` · `lifecycle.ts` · `soak-wss.ts` · `ssh-forward.ts` | The runbook scripts above.                                                                                             |

## Config / env reference

| Env                                       | Default                  | Meaning                                                      |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| `DAYTONA_API_KEY`                         | — (required)             | Daytona API key (provisioning only; never on the data path). |
| `DAYTONA_TARGET`                          | `eu`                     | Region (`us`/`eu`; no Asia region today).                    |
| `ZEROS_SNAPSHOT_NAME`                     | `zeros-engine-v0`        | Snapshot name (bump suffix on image-spec change).            |
| `ZEROS_REPO_URL` / `ZEROS_REPO_REF`       | `withso/zeros` @ `main`  | Repo + ref the image builds.                                 |
| `ZEROS_NODE_BASE_IMAGE`                   | `node:22-bookworm`       | Base image.                                                  |
| `ZEROS_CLOUD_PORT`                        | `39393`                  | The 0.0.0.0 bridge port (CloudTransport).                    |
| `ZEROS_SANDBOX_CPU` / `_MEMORY` / `_DISK` | `2` / `4` / `10`         | Box resources (vCPU / GiB / GiB).                            |
| `ZEROS_SOAK_HOURS` / `ZEROS_SOAK_PING_MS` | `4` / `25000`            | Soak duration / ping cadence.                                |
| `ZEROS_SPIKE_SKIP_RECONNECT`              | unset                    | `1` skips the test-client stop()/start() step.               |

> **Security:** any secret injected via env/files is readable by a context-injected agent inside the box — use short-lived, narrowly-scoped tokens; never bake a long-lived key into the snapshot (the spike mints the cloud token per-provision and keeps creds out of the image).
