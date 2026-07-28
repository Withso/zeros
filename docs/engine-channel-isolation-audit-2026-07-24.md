# Engine channel-isolation incident audit — 2026-07-24

## Outcome

Zeros Beta's repeated engine respawn and the resulting create/archive/restore
failures began as a cross-channel process-ownership bug, not a stale renderer
cache, an unapplied database migration, or missing code in the Beta update.

Stable and Beta were both assigned the packaged engine walk
`24193–24200`. An older installed Stable build's range reaper treated Beta's
live engine as its own orphan and killed it. Beta's watchdog correctly noticed
the loss and respawned, but Stable killed the replacement again. This produced
the observed roughly 21-second loop and made every engine-backed workspace
operation unreliable.

### Beta.84 follow-up: packaged native file watching deadlocked the engine

Beta.84 correctly moved to the isolated `24203–24210` engine range, and its
manifest, listener PID, release channel, and port all agreed. It still repeated
the same visible watchdog loop for a different reason. The engine's early
same-process ownership proof returned the right nonce, but it ran before the
rest of startup. `startGitWatcher()` then armed Chokidar's native macOS
FSEvents backend; inside the Bun `--compile` runtime that deadlocked the main
event loop. Independent clients completed a TCP handshake and received no
bytes, so Electron's exact `/health` check failed and killed the engine every
~21 seconds.

The same shipped binary reproduced on a clean temporary root and unused port
without Electron or the user's database. A macOS process sample showed the
compiled sidecar's main thread blocked on an unfair lock. Source-mode Dev did
not reproduce it. This rules out workspace rows, lifecycle journals, renderer
cache, updater state, and machine-specific app data as the Beta.84 cause.

The permanent correction uses Chokidar's 1.5-second stat-poll backend in
packaged/non-Dev engines and retains native watching in source-mode Dev. It
also moves the authoritative ownership/liveness proof to the independent
Electron host.
Readiness is not published until the host receives three consecutive matching
nonces from `/health`; a failure kills that child and advances monotonically
through only the remaining ports in the channel's range. Release smoke testing
now requires sustained external `/health` responses after the engine's ready
line plus a create → archive → restore bridge round trip instead of accepting a
listen socket or a same-process early probe. The same compiled-artifact smoke
now runs in the macOS pull-request preflight as well as release and scheduled
workflows.

## Evidence

- The supplied `0.0.14-beta.83` and `.84` logs contain diagnostics introduced
  by the merged self-verification change, proving that the updated code was
  installed and running. This rules out an updater or renderer-cache
  explanation for the incident.
- An earlier `0.0.14-beta.82` launch successfully connected, created
  workspaces, and archived a workspace. The same build entered the respawn loop
  after a later relaunch, which rules out the workspace lifecycle implementation
  as the primary failure.
- While Stable and Beta were open together, both engine listeners occupied
  ports in `24193–24200`, both health endpoints failed in sync, and both engine
  PIDs changed at the watchdog cadence.
- Stable's main log explicitly reported reaping the PID that was, at that
  moment, Beta's live engine child. That is the causal event immediately before
  each Beta respawn.
- Stable and Beta both had all 23 database migrations applied, their expected
  tables present, and separate app-data databases and visible workspace roots.
- The affected Beta.84 database returned `ok` from `PRAGMA quick_check`, held
  five live and five archived workspaces, and had zero pending lifecycle-journal
  rows. No database repair or cache reset was indicated.

## Why Dev worked

Dev already owned a separate engine block (`24293–24300`) and separate app-data,
database, workspace, renderer-storage, and log roots. Stable's packaged-range
reaper could not see the Dev engine. Beta had most of the same state isolation,
but its engine range was still selected by a binary dev/prod decision, so it
silently shared Stable's one machine-global runtime resource.

Testing in Dev is necessary but not sufficient for a packaged release. The
source can be identical while these execution conditions differ:

| Boundary                        | Dev                            | Beta                    | Stable                  |
| ------------------------------- | ------------------------------ | ----------------------- | ----------------------- |
| Runtime form                    | Source/Bun + Electron dev host | Signed packaged sidecar | Signed packaged sidecar |
| Release channel                 | `dev`                          | `beta`                  | `stable`                |
| App data / DB                   | `com.zeros.dev[.<instance>]`   | `com.zeros.beta`        | `com.zeros`             |
| Visible workspaces              | `~/zeros-dev[-<instance>]`     | `~/zeros-beta`          | `~/zeros`               |
| User settings/state             | `~/.zeros-dev`                 | `~/.zeros` (shared)     | `~/.zeros` (shared)     |
| Updater feed                    | None                           | Beta feed               | Stable feed             |
| Engine footprint after this fix | `24293–24302`                  | `24203–24212`           | `24193–24202`           |

Each footprint includes the eight-port engine walk and the two fixed gateway
ports. Packaged validation must exercise Beta and Stable concurrently because
Dev alone cannot expose cross-channel ownership bugs.

The shared packaged user-settings root is a separate, pre-existing product
choice and was not causal here: the failing workspace databases, manifests,
and worktree registries were already channel-separated. It should be revisited
as its own migration if Beta-specific settings are desired; silently moving it
during an engine incident would reset or fork user configuration.

## Permanent invariants

1. **One channel, one non-overlapping footprint.** Stable remains pinned to
   `24193` for compatibility. Beta moves to `24203`, after Stable's engine walk
   and gateway ports. Dev remains at `24293`.
2. **One resolver.** Electron resolves the base lazily through
   `src/engine/runtime.ts` after the packaged channel has been seeded. The host,
   spawned engine, renderer fallback, localhost inspector, CLI, and docs use
   the same channel map.
3. **Exact engine identity.** The engine writes its per-boot nonce into
   `engine.json`. Readiness and watchdog health checks accept only a response
   echoing that nonce, rather than accepting any healthy-looking service on the
   port.
4. **Fail-closed reaping.** A listener is eligible for cleanup only when its
   command is engine-shaped and its parent PID is positively known to be `1`.
   Failure to read the parent PID never authorizes a kill.
5. **Regression coverage.** Tests assert that the full Stable/Beta/Dev
   footprints are disjoint, foreign manifests/health responses are rejected,
   unknown/live parents are spared, and an OAuth registration tied to Beta's
   former callback port is safely re-registered without discarding tokens.
6. **Readiness is cross-process and sustained.** Electron publishes a port only
   after three consecutive external exact-nonce responses, and the macOS release
   gate boots the compiled artifact and requires the same post-ready stability.
7. **Packaged watching uses a runtime-safe backend.** Source-mode Dev may use
   native FSEvents. Bun-compiled packaged engines use Chokidar's polling backend
   so filesystem observation cannot block the bridge event loop.

## Rollout compatibility

The important upgrade direction is safe: an older Stable build scans only
`24193–24200`, while the upgraded Beta starts at `24203`. Therefore the older
binary that caused this incident cannot see or reap the new Beta engine. Stable
does not need to update first.

The port change is runtime metadata only. It does not move or reset Beta's
database, workspaces, login state, or migrations. Electron supplies the actual
bound port to the renderer, so no user action or cache clearing is required.
If an MCP OAuth backend has a dynamic client registration containing Beta's old
callback port, the gateway drops only that stale registration and performs
dynamic registration again when needed; existing tokens and header credentials
remain intact.

## Packaged acceptance test

1. Install the candidate Beta while the current Stable release remains
   installed.
2. Launch both apps and confirm their engine boot logs report
   `stable · base port 24193` and `beta · base port 24203`.
3. Keep both open for at least two watchdog windows. Each channel's engine PID
   must remain stable and each `/health` response must carry its owned manifest
   nonce.
4. In Beta, create a workspace, archive it, restore it, and open it after an app
   relaunch.
5. Repeat the workspace lifecycle in Stable, then run both apps concurrently
   again. Neither log may report reaping a live child owned by the other app.
