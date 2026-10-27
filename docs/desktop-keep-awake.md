# Keep the Mac awake during agent work

Settings → Local → General → **Caffeinate while agents are running** is an
opt-in preference for this Mac. It defaults off and applies to Local Personal,
organization-local and organization-cloud chats, including agent background
tasks and running workflows. Changing the selected owner, workspace or tab does
not change the setting or discard another chat's work.

The Mac stays awake while Zeros observes active work. The screen can turn off
and lock normally. An idle session, a new chat warming before its first prompt,
or a turn waiting only for a blocking question or approval does not prevent
sleep. Independent background tasks keep the assertion while their parent waits.
An explicit cloud send waiting for its workspace to start also counts. Merely
enabling the preference never starts or wakes a cloud workspace.

On battery power, prevention pauses below 10% and resumes at 10% or on AC power
if work continues. A failed or unknown battery reading also pauses prevention.
The preference remains enabled during these pauses. Charge is checked every
30 seconds while enabled work is active, with a three-second read deadline;
power-source changes trigger an immediate recheck. Desktop Macs without a
battery work on AC power. UPS battery power uses the same cutoff.

This prevents **idle system sleep**. Closing the lid, choosing Sleep, shutting
down, and macOS thermal or critical-battery sleep remain under macOS control.
Monitoring continues with the Zeros window minimized or hidden. Closing the
last window, reloading it, a renderer crash, or quitting releases the assertion;
a new renderer must report fresh activity. Cloud jobs themselves continue under
the existing worker lifecycle independently of this device preference.

## Ownership and lifecycle

- Electron main owns one `powerSaveBlocker` with `prevent-app-suspension`, its
  battery checks and cleanup. No OS power settings are changed, no privileged
  helper is installed, and no `caffeinate` child process needs supervision.
- The device preference lives in `userData/app-settings.json` under
  `keepAwakeWhileAgentsRunning`. It is separate from account synchronization,
  repository TOML, cloud worker settings and Chromium's purgeable cache. Runtime
  activity and blocker IDs are never persisted.
- The always-mounted renderer controller aggregates the existing provider-neutral
  execution state. It sends only a boolean over three narrow native commands;
  the handlers validate boolean inputs and the current main window/main frame.
  No conversation content or workspace identity reaches this native service.
- Activity changes are event-driven. Main additionally asks for a fresh snapshot
  every 30 seconds while monitoring; a 90-second lease bounds stale renderer
  activity. Hidden-page renderer timers do not own battery or expiry checks.
  A lost renderer or system suspend revokes its activity immediately.
- `/usr/bin/pmset -g batt` is a bounded, read-only invocation with a fixed locale,
  no shell, and no user-controlled arguments. Battery reads are single-flight;
  source transitions, disabling, idle and disposal fence late results. There is
  no recurring I/O or timer while disabled or idle.

## Research and alternatives

Primary sources reviewed on 2026-10-27:

1. [Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker)
   documents that `prevent-app-suspension` keeps the system active while allowing
   the screen to turn off. `prevent-display-sleep` would unnecessarily keep the
   display on. The repository uses Electron 43; its
   [versioned API documentation](https://github.com/electron/electron/blob/v43.0.0/docs/api/power-save-blocker.md)
   has the same contract.
2. [Chromium's macOS implementation](https://chromium.googlesource.com/chromium/src/+/main/services/device/wake_lock/power_save_blocker/power_save_blocker_mac.cc)
   maps this mode to `kIOPMAssertionTypeNoIdleSleep` and releases the corresponding
   IOKit assertion. Native assertion work runs away from the UI thread.
3. [Apple QA1340](https://developer.apple.com/library/archive/qa/qa1340/_index.html)
   distinguishes idle sleep from forced sleep, including lid closure, explicit
   Sleep, thermal emergencies and low battery. An idle assertion does not grant
   authority to override those actions.
4. [Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor)
   provides suspend/resume and AC/battery transitions, but no battery percentage.
   [Apple's pmset manual](https://github.com/apple-oss-distributions/PowerManagement/blob/main/pmset/pmset.1)
   documents `-g batt` for system battery/UPS status and `-g assertions` for
   inspecting active assertions. Only the read form is used here.
5. [Apple's caffeinate manual](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.8)
   distinguishes idle (`-i`), display (`-d`) and AC-only system (`-s`) assertions.
   Electron already exposes the needed native mechanism, so spawning a separate
   utility or writing persistent `pmset` settings adds no benefit.

## Verification

Native unit tests cover the 9%/10% boundary, AC recovery, unknown power data,
single-flight reads, stale results, assertion sharing, activity expiry, trusted
IPC senders, persistence failures, window replacement, reload, crash and quit.
Renderer tests cover all three placements, providers, background work, blocking
questions, owner-independent aggregation, native refreshes and preference races.

For native acceptance on macOS, enable the setting and start an agent or an
agent-owned background task. `pmset -g assertions` should show an idle-system
sleep assertion owned by Zeros while work runs, including with the window
minimized and after switching to another owner. Ending the last task or turning
the setting off must release it. A cloud task must hold the assertion on the
Mac, without changing the VM's own idle policy. Verify battery cutoff and resume
with controlled battery inputs; unit tests cannot establish physical sleep
behavior on a Mac.
