# Cloud engine connection diagnostics (Alpha only)

Run from the credentialed operator workspace after checking out
`cloud-v2/fix-engine-connect`:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/engine-connect-repro.mjs --run --workspace WORKSPACE_UUID
```

The script reads `.env.agent` in process using the same Alpha/test credential
names and checks as `template-setup-repro.mjs`. The database connection is
read-only and rolls back. It reads the current generation's Boat resource,
engine registrations/leases/revocations, lifecycle intents, checkpoint state,
client-access retirement reasons, and actor admission/renewal timestamps.
It does not select credential hashes, bearer values, auth sessions or payloads.

A running VM is inspected read-only: bounded engine-log classifications only.
The tool never restarts or changes the source VM. An archived VM with a
completed snapshot is forked using `noEnv: true`, empty environment, a
30-minute lease and an idempotency key. The child is named
`zeros-v2-test-engine-connect-<run-id>`. The old engine log is classified before
the child runs a new diagnostic engine.

On that fork, the probe uses the installed `cloud-engine-launcher` in `serve`
mode, its normal mount projection, cgroup and UID/capability transition. It
creates a fresh secret-free computer admission if necessary. The engine has
no original registration or heartbeat authority. Its WebSocket is tested with
an ephemeral bootstrap token and an ephemeral RSA account key; mandatory
asymmetric account binding stays enabled. The private key remains in memory
in the fork. The probe sends `CONNECTED` with the recorded protocol version
and requests `workspace.list`, recording upgrade, readiness, response/rejection,
close code, allowlisted close reason and wall-clock duration. It captures only
closed log categories, never raw log lines, paths, messages, stdout or stderr.
No authored hooks, agents, Git fetches or control-plane writes are requested.
It then repeats with an RPC before `CONNECTED` (`outOfOrderSocket`) to test the
failure caused by publishing connected listeners before sending the handshake.

This isolated serve check tests the installed engine and its v4 view. It does
**not** establish a real actor session, exercise the production control-plane
relay/provider preview hop, or prove registration/renewal. Those are explicit
`preconditions` in the output. Production actor timestamps help distinguish
pre-consumption, first-handshake, and renewal failures without minting or
replaying a client capability. A successful synthetic probe is not proof of
a successful desktop attachment.

The source resource is never stopped, resumed, renamed, or deleted. Child
deletion runs in `finally`, including after a failed probe. A completed delete
or a blocked storage-only stage plus child GET returning 404 establishes
compute release, not storage erasure. Cleanup journals are mode 0600 under
`.context/zeros-v2-test-engine-connect/`. If interrupted, retain the journal and
run:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/engine-connect-repro.mjs --cleanup RUN_UUID
```

## Initial path audit (before the client fix, ea34b8ac)

- `apps/control-plane/src/cloud-workspaces/runtime-bridge.ts:498`: the reported
  `upstream_closed` category requires the desktop WebSocket upgrade to have
  completed. The relay's `admitted` counter alone does not establish that;
  a failed upstream HTTP handshake is categorized `upstream_failed`.
- `apps/desktop/src/engine/transport/cloud.ts:1099`: the engine redeems the
  one-use grant before upgrading. Afterward, client authority lasts at most
  ten seconds and renews halfway through that lease; the protocol requires
  `CONNECTED` within ten seconds. The close reasons distinguish those gates.
- `apps/desktop/src/engine/zeros-engine.ts:5241`: `CONNECTED` checks protocol
  compatibility, then binds the control-plane-asserted account. The v2 actor
  capability check precedes dispatch. Workspace operations and transport
  control messages need separate coverage in a real actor-admission run.
- `apps/desktop/src/renderer/platform/bridge/ws-client.ts:1145`: cloud clients
  send protocol `CONNECTED` without a reusable WorkOS bearer. A socket upgrade
  marks transport connected before the initial workspace-list RPC completes.
  At `:1130`, status listeners ran before `CONNECTED` was sent.
  `cloud-github-native.ts:32` registers a listener before the initial socket
  opens and immediately sends `github.nativeGrant`; reconnect replay listeners
  can do the same. This is a concrete first-frame ordering defect, not merely
  a reconnect-only candidate. The engine's rejection is the correct boundary.
- `apps/desktop/src/engine/cloud-idle-stop.ts:4` and
  `apps/control-plane/src/cloud-workspaces/idle-stop.ts:21`: ten minutes of
  engine-observed inactivity can request a durable checkpoint and stop. A
  revocation roughly ten minutes after registration is consistent with this
  path, but requires the lifecycle/checkpoint evidence; it is not by itself
  proof of lease expiry or a client-driven stop.
- `scripts/cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs:332`
  starts the engine detached under the VM supervisor. Desktop transport
  retirement must remain independent of that engine lifetime and active jobs.

The operator should return the JSON report including `cleanup`, `timeline`,
`previousLog` and `serve`; no raw logs or credentials are needed.

## Client compatibility and recovery

The fixed client sends `CONNECTED` first and waits for a successful
`workspace.list` response before notifying connected listeners. That read is
available on the deployed engine; `ENGINE_READY` alone cannot acknowledge
authentication because the engine sends it before handling `CONNECTED`.
Only that one small read can enter the pre-authentication queue. Afterward,
ordinary client RPCs have a 16-request concurrency limit, preserving the
engine's existing frame and byte limits even when a full disconnect queue
drains. Dispatched requests are never automatically replayed.

Attachment snapshots install their journal cursor before buffered live events
and durable replay resume through one ordered reader. A connection or engine
replacement retires older snapshot and replay work. Reconnect also revalidates
Git and file views. Background history hydration and chat mirroring require a
running workspace; explicitly opening retained history remains supported.

Client and relay logs record allowlisted close/request classes, numeric close
codes, reconnect delay and workspace/generation identity. They bound reports
per minute and exclude arbitrary reasons, request arguments, credentials and
endpoint URLs. The relay additionally identifies the engine and whether the
failure occurred during upstream upgrade or an established relay.

The attachment fix needs an app update only: it does not require a new engine
runtime, base, or Cloud Computer rebuild. Deploying the control-plane change
adds upstream diagnostics. VM supervision, command ownership and idle-stop
policy are unchanged; closing a client does not stop accepted cloud work.

The credential-free `scripts/__tests__/cloud-client-handshake.test.ts` exercises
the actual desktop client, control-plane relay and engine WebSocket transport
with slow authentication, initial/reconnect listeners and up to 256 queued
requests. It does not replace a live app attachment through the provider proxy.
