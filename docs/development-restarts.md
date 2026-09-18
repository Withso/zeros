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
health probe at a time, bounds each request to 1.5 seconds and 8 KiB, and checks
the exact root/port/boot identity after asynchronous work. Five failures trigger
recovery; repeated replacements with no healthy response retain exponential
backoff. Ownership is checked again inside the shared spawn queue, so a delayed
failure from an old engine cannot restart its replacement. Shutdown invalidates
pending probes and startup rechecks shutdown after its prerequisites.

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
