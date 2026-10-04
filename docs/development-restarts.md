# Development restarts and active agent turns

`pnpm electron:dev` and `pnpm electron:dev:watch` rebuild Electron main/preload
and the engine, while Vite updates the renderer. Primary and named development
instances use `scripts/dev-main-supervisor.mjs`. A main-process restart also
ends its engine and provider processes, so it must respect active turns just
as an engine-only reload does.

Before an automatic main restart, the supervisor asks its own child over
private Node IPC for restart readiness. The main process checks the current
engine's app-data `engines/<repo-key>/busy` heartbeat. A busy response defers
the restart; missing, malformed, stale-request or failed replies cannot
authorize termination. Startup without an engine identity is also busy.
Requests and retries are bounded and coalesced, and explicit app quit still
exits the development stack. Both compiled outputs must exist and contain data
before restart; byte-identical rebuilds do not restart the app. A change arriving
during a readiness check is rechecked instead of being dropped.

The engine refreshes the heartbeat every ten seconds while prompts are active.
Its lease begins before prompt persistence and the pre-turn snapshot. Leases
belong to individual turns: retirement releases them even when an old provider
promise never settles, and late cleanup cannot release a successor's lease.
Both reloaders wait for it to clear. An abandoned heartbeat expires after
thirty seconds, but a refreshed long-running turn has no five-minute forced
restart. An unreadable heartbeat is conservatively busy. The main supervisor
uses SIGTERM only after an idle reply; the supervised main handles that signal
through normal `app.quit()` cleanup before any bounded kill escalation.
This is development lifecycle coordination, not a new provider or renderer
permission boundary. Production installs have no development restart handler.

Production and development both have a separate crash watchdog. It allows one
health probe at a time, normally bounds each request to 1.5 seconds and 8 KiB,
and checks the exact root/port/boot identity after asynchronous work. Five misses
require a longer confirmation: 15 seconds for an idle child, or 60 seconds after
recent child output. Output alone cannot extend that confirmation indefinitely.
An observed child exit recovers without waiting for HTTP. Delayed host timers
after sleep or load do not count as independent engine failures.

The engine also sends private `engine.heartbeat` frames over its existing host
control pipe every three seconds and at activity transitions. Frames contain
only the boot nonce, an advancing sequence, and active request/turn counts.
Outstanding work with an advancing heartbeat defers global replacement; idle
heartbeats do not hide a broken listener. Work evidence expires five minutes
after the last heartbeat if the engine event loop stops. A stale child or nonce
cannot renew another engine's lease. This signal is separate from the filesystem
heartbeat used by development reloaders and never goes to renderers or relays.

Ownership, current work and the age of the confirmation are checked again in
the shared spawn queue and after spawn prerequisites, before terminating the
child. Repeated replacements with no healthy response retain exponential
backoff. Shutdown invalidates pending probes and stops activity publication.
Heavy work in one workspace must not restart agents in other workspaces merely
because a short HTTP probe timed out.

A Local prompt that loses its response socket re-adopts its exact live execution
without starting a provider or resending the prompt. Session-scoped terminal
events and the saved turn record establish completion, including completion
while disconnected. The renderer fills transcript gaps before releasing queued
follow-ups, even if the socket drops again during backfill. Unavailable history
keeps follow-ups queued; exhaustion of the bounded backfill wait pauses them
for an explicit send. Read timeouts retry with backoff during a five-minute
recovery window, matching the host's allowance for stalled active work. A confirmed
missing execution fails immediately. Recovery failure retains the conversation
and surfaces uncertainty; it never silently repeats a possibly committed operation.

## Testing a synced checkout

When source is being mirrored into a checkout while testing the app, use
`pnpm electron:run` after synchronization finishes. It builds once and runs
without the main/engine rebuild watchers. Restart that command explicitly to
pick up subsequent backend changes. Renderer Vite updates still apply.

`ZEROS_NO_MAIN_HMR=1` and `ZEROS_NO_ENGINE_HMR=1` independently disable the two
automatic backend restart paths in a normal development run. Disabling only
engine HMR does not disable a main-process restart. Changes to the launcher or
supervisor itself require restarting the development command once.

If a process was killed during a tool call, its saved transcript may contain
an unresolved tool start with no result. That row is not evidence that the
tool is still executing or that its edits committed. Resume explicitly, inspect
the current files/request status, preserve completed work and continue from
there. Do not automatically replay a possibly committed write or create a
duplicate frame. A run started before a sync/rebuild used the preceding engine
and instructions, even if the new bundle finished building during that run.

Regression coverage uses real supervised child processes to verify active-turn
deferral, idle restart, unavailable readiness, incomplete/identical builds and
explicit quit. Electron-side tests cover engine identity, fresh versus stale
heartbeats, long turns, handler cleanup, overlapping probes, replacements during
probes/diagnostics and incomplete health responses. Host qualification must also
run the macOS packaged-engine smoke; isolated tests do not substitute for a live
provider run during Electron hot reload.

macOS host qualification on 2026-09-18 exercised the actual Electron binary in
an isolated temporary app: a rebuild stayed pending while its engine heartbeat
was busy, the app restarted exactly once after idle, and supervisor shutdown
reached Electron's `before-quit` cleanup. The rebuilt packaged engine passed
sustained health and workspace create/archive/restore smoke checks.
