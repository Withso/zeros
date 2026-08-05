# Cloud workspace provider validation

This directory is an operator-run validation harness for the Zeros engine in a
remote Daytona sandbox. It proves that a sandbox image can boot the engine,
serve a token-gated bridge, complete `file.tree` and PTY round trips, reconnect
after stop/start, and expose useful lifecycle, socket, egress, and SSH metrics.

This is not a deployable application or a product roadmap. Nothing in the
packaged desktop app imports these scripts, and repository builds exclude them.
The harness requires a paid provider account and is therefore not exercised by
public CI; treat a result as unverified until an operator runs the complete
sequence against the provider account and records the run externally.

## Engine boundary under test

[`CloudTransport`](../../apps/desktop/src/engine/transport/cloud.ts) starts only
when `ZEROS_CLOUD_PORT` is set. It binds a second HTTP/WebSocket server to
`0.0.0.0`, behind the sandbox provider's preview proxy, while the desktop-only
`LocalTransport` retains its loopback and origin defenses.

The WebSocket upgrade requires two independent headers:

- `x-daytona-preview-token` authenticates the provider preview proxy.
- `x-zeros-cloud-token` authenticates the Zeros bridge.

The harness keeps both tokens out of request URLs and writes its connection
state atomically to `.context/cloud-workspace-validation/state.json` with
directory mode `0700` and file mode `0600`. Successful `--delete` cleanup
removes that file. The legacy `.context/cloud-spike/state.json` location is
migrated once for compatibility.

Account/workspace binding is a separate product requirement. When the engine
runs without account-auth configuration, the shared bridge token is the only
Zeros-level remote gate; do not expose this harness as a multi-tenant service.

Local transport sanity check, without a provider account:

```bash
pnpm build:engine
ZEROS_CLOUD_PORT=39393 ZEROS_CLOUD_TOKEN=test node dist-engine/cli.js serve --root .
curl localhost:39393/health
```

Unit coverage lives in
`apps/desktop/src/engine/transport/__tests__/cloud-transport.test.ts` and
`scripts/__tests__/cloud-workspace-validation-config.test.ts`.

## Prerequisites

```bash
export DAYTONA_API_KEY=dtn_... # required
export DAYTONA_TARGET=eu       # optional: us | eu; default eu
```

`@daytona/sdk` is an exact root dev dependency. Run commands from the repository
root with `pnpm tsx scripts/cloud-workspace-validation/<name>.ts`.

## Validation sequence

| Order | Command                                                                      | Validates                                                     |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1     | `pnpm tsx scripts/cloud-workspace-validation/bake-snapshot.ts`               | Reproducible image build and native Node ABI                  |
| 2     | `pnpm tsx scripts/cloud-workspace-validation/provision.ts`                   | Sandbox create, engine start, health, and private local state |
| 3     | `pnpm tsx scripts/cloud-workspace-validation/test-client.ts`                 | Handshake, file tree, PTY, and stop/start reconnect           |
| 4     | `pnpm tsx scripts/cloud-workspace-validation/egress.ts`                      | Required outbound provider and package endpoints              |
| 5     | `pnpm tsx scripts/cloud-workspace-validation/lifecycle.ts`                   | Stop/start and archive/restore latency                        |
| 6     | `ZEROS_SOAK_HOURS=4 pnpm tsx scripts/cloud-workspace-validation/soak-wss.ts` | Long-lived socket stability and reconnect behavior            |
| 7     | `pnpm tsx scripts/cloud-workspace-validation/ssh-forward.ts`                 | SSH local-forward fallback                                    |
| 8     | `pnpm tsx scripts/cloud-workspace-validation/lifecycle.ts --delete`          | Provider resource and local credential cleanup                |

Set `ZEROS_CLOUD_VALIDATION_SKIP_RECONNECT=1` only for a deliberately shortened
local iteration. The legacy `ZEROS_SPIKE_SKIP_RECONNECT` name remains accepted
temporarily so existing operator scripts do not break.

The harness automates bridge, PTY, reconnect, egress, lifecycle, soak, and SSH
checks. Multi-client authorization, long-term billing behavior, production file
mirroring, reconciliation workers, and vendor redistribution approval are out
of scope and must not be inferred from a successful run.

## Files

| Path                      | Responsibility                                               |
| ------------------------- | ------------------------------------------------------------ |
| `config.ts`               | Provider client, resources, private state, and URL helpers   |
| `image.ts`                | Canonical Daytona image specification                        |
| `Dockerfile`              | Portable equivalent for local Docker/provider validation     |
| `sandbox/start-engine.sh` | In-sandbox engine launcher                                   |
| `sandbox/egress-probe.sh` | In-sandbox outbound endpoint probe                           |
| `lib/bridge-client.ts`    | Minimal bridge handshake, request, and PTY client            |
| Remaining `.ts` files     | Ordered operator commands from the validation sequence above |

## Configuration

| Variable                                  | Default              | Purpose                                           |
| ----------------------------------------- | -------------------- | ------------------------------------------------- |
| `DAYTONA_API_KEY`                         | required             | Provisioning API credential; never enters sandbox |
| `DAYTONA_TARGET`                          | `eu`                 | Provider region (`us` or `eu`)                    |
| `ZEROS_SNAPSHOT_NAME`                     | `zeros-engine-v0`    | Registered image/snapshot name                    |
| `ZEROS_REPO_URL` / `ZEROS_REPO_REF`       | public repo / `main` | Source revision baked into the image              |
| `ZEROS_NODE_BASE_IMAGE`                   | `node:22-bookworm`   | Sandbox base image                                |
| `ZEROS_CLOUD_PORT`                        | `39393`              | CloudTransport bind port                          |
| `ZEROS_SANDBOX_CPU` / `_MEMORY` / `_DISK` | `2` / `4` / `10`     | vCPU / GiB / GiB                                  |
| `ZEROS_SOAK_HOURS` / `ZEROS_SOAK_PING_MS` | `4` / `25000`        | Soak duration and operation cadence               |
| `ZEROS_CLOUD_VALIDATION_SKIP_RECONNECT`   | unset                | Skip only the reconnect portion of `test-client`  |

Any credential injected into the sandbox can be read by code running there.
Use short-lived, narrowly scoped values, never bake credentials into the image,
and run the delete step when validation finishes.
