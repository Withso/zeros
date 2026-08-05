# Cloud workspace infrastructure and operations

## Build and image contract

The remote image must be reproducible from reviewed source and a pinned runtime
set. It must include only the engine, approved agent runtimes, native modules for
the image ABI, and documented operator tooling. Image creation fails when a
native rebuild, license-generation step, integrity check, or required runtime
stage fails.

Record an immutable image identifier with every workspace generation. A
workspace may be upgraded only through a versioned, observable operation with a
rollback or recovery path.

## Lifecycle states

Use explicit states such as requested, provisioning, setting-up, ready, busy,
stopping, stopped, waking, archiving, deleting, deleted, and failed. The exact
wire values become compatibility contracts when introduced.

- Create, stop, wake, archive, and delete accept idempotency keys.
- Reconciliation compares desired state, provider-observed state, engine health,
  and durable-record state.
- A failed setup retains bounded logs and a safe retry/delete path.
- Idle policy never stops a workspace with active agent work, an acknowledged
  interactive terminal, or an in-flight durable write.
- Delete revokes grants first and completes only after provider inspection says
  the execution resource is gone.

## Readiness and health

Provider process health, engine health, repository readiness, protocol
compatibility, and user-action readiness are different signals. A listening
port alone is not readiness. Publish a workspace as ready only after the engine
handshake and repository checks succeed.

Health endpoints disclose no secrets, repository names, user identity, or
internal stack traces. Privileged diagnostics require normal workspace
authorization.

## Observability

At minimum, record:

- lifecycle transition latency and failures;
- setup step timings and bounded sanitized logs;
- engine reconnects, protocol mismatches, and revision-gap recovery;
- resource allocation, active/idle time, and quota decisions;
- durable-write lag and restore results; and
- reconciliation drift and orphan cleanup.

Do not set public reliability or latency promises until measurements exist from
representative regions, repositories, agents, stop/wake cycles, and long-lived
connections.

## Provider portability

The provider interface owns compute/image identifiers, endpoint grants,
lifecycle calls, usage, and logs. Application schemas store a provider name and
opaque provider resource ID behind the stable Zeros workspace ID. Provider
features such as snapshots are optimizations, not the only recovery mechanism.

## Current validation harness

The operator-only harness in
[`scripts/cloud-workspace-validation/`](../../scripts/cloud-workspace-validation/README.md)
tests image creation, engine boot, bridge and PTY round trips, stop/start
reconnect, egress, lifecycle latency, socket soak, SSH fallback, and cleanup.
Public CI cannot claim those provider-account checks passed.

Before production implementation begins, complete the full sequence and store
dated results in the private operational system. Never commit provider API keys
or generated connection state.

## Deployment ownership

- Railway deployment configuration stays with `apps/control-plane/`.
- Cloudflare Pages management UI stays with `apps/web/` while it shares that
  deployment.
- Provider-validation scripts stay outside shipping application graphs.
- Add a separate execution-coordinator app only if it becomes independently
  built, deployed, scaled, and operated.
