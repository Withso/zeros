# Terminal placement and navigation

Workspace terminals open in the workbench tab strip. The add menu creates a
plain shell; terminal agents in Conversation remain a separate feature. A
default Setup tab makes setup output and the terminal sidebar discoverable.
The sidebar lists Setup, configured Run actions (or Add run script), and the
workspace's plain shells. Selecting a row opens or focuses that destination's
own tab. It never replaces another terminal or starts a Run command.
Without a selected workspace, terminals use the engine's fallback folder while
their tabs stay in the visible ambient workbench scope.
During boot, the persisted last workspace folder owns both terminal lookup and
tab reconciliation until the live chat selection is restored.

The add menu also groups Setup and platform-eligible Run actions under
Environment (Play icon). Selecting a submenu item opens or focuses that
terminal in its current placement; it never starts a command. The main menu
and submenu are each 280px wide with a local 16px corner radius; the main
search row is 40px high. The main menu starts below the plus and shifts within
the window at the right edge. The submenu opens right and flips left when
needed. Pointer hover and keyboard Right/Enter enter the submenu; Left/Escape
return to search. Closing resets its selection, and switching workspace scope
unmounts both menus. Settings and file data warm on plus-button intent and
reuse their existing exact-key caches.
Searching also lists matching Setup and Run action names under Environment,
with the same icons and destination identities as the submenu. Matching shares
the file/page search rules (case and accent folding, all query terms, and fuzzy
subsequences). These results update with live settings and open the existing
placement, including revealing a collapsed bottom panel, without starting work.

Each terminal can move independently into the resizable bottom panel. Its tab
leaves the primary strip and joins the panel's horizontal strip. The panel's
return button restores that same tab. Selecting a docked sidebar entry focuses
and expands its panel. New terminals from the primary add menu or sidebar open
in the primary strip; the bottom panel's plus creates a docked terminal.

The sidebar and primary tabs use Settings for Setup, the configured action icon
for Run, and the plain Terminal glyph for shells. Icons use `--fg2` unless
selected (`--fg1`). Docked sidebar rows use `--fg3` for their name and icon and
carry a 14px dock marker matching the row icon; they remain interactive. Bottom-panel tab
labels omit destination glyphs; running actions show the same animated wave
as primary tabs, with outcome dots retained after completion. Hidden workspace
panels suspend their waves. Bottom tabs retain
the existing close controls. Run icon changes reuse the shared settings/status
snapshot and update without waiting for a status change.

The main terminal header shares the Files title chip and 14px action icon
geometry. The dock button sits at the right edge immediately before Environment
settings and the sidebar toggle, with 4px action gaps, including when the sidebar
is hidden. The bottom panel's collapse/expand arrow precedes its tabs and stays
outside the scrolling tab lane, with the same 4px gap as neighboring tabs.
Below Setup/Run actions, a
separator introduces the Terminals heading and New terminal button. Docked
shell rows swap their dock/close glyphs in the same fixed 24px slot.
The sidebar uses the Files resize interaction: a 1px divider with a centered
7px grab area, an east–west resize cursor, and the shared idle "Drag to resize"
hint. Both sides of the divider start the same drag gesture, which commits
the shared sidebar width preference on release.

Each configured action row reveals Run (`--blue-fg`) on hover or visible
keyboard focus. Setup reveals the same Run button, which uses its existing
runner to start or rerun setup and reset the log in place. It opens Setup in
its current placement and is disabled while setup is starting or running, or
without a workspace. The retained view owns its command guard and error handling;
pending requests remain scoped to their workspace without redirecting a newer
selection. While a Run action is running, its row instead exposes bordered globe and Stop
buttons with `--bg1` backgrounds and `--fg1` text, ports, and icons. The same controls sit after the main header's
title, or at the bottom panel's right edge when that run is selected and expanded.
Headers show Open with the detected port and Stop, without shortcut hints. Below
480px of header width, container queries reduce them to 24px icon buttons without
changing their accessible names or actions. Sidebar controls always stay compact.
Live Stop
controls no longer overlay terminal output; completed outcome/Rerun overlays
remain. Hidden row controls cannot intercept pointer events. Stop does not
change either selection. The controller still owns Cmd+R: start the default
action, or reveal its existing placement when already running.

The globe opens the run's detected local HTTP(S) address through the existing
Browser navigation path, reusing an exact URL. It stays disabled until a complete
output line provides an address. One workspace controller shares preview state
across all buttons, observes running PTYs, and warms their existing Run log
snapshots. The cache keys by workspace, session, and run start time, retains
at most 128 runs with bounded partial lines, and ignores superseded reads.
Hidden workspaces suspend preview reads/listeners; returning restores cached
addresses synchronously and revalidates missed output. Owner removal prunes
preview keys through the terminal store's existing normalized folder predicate.
Settings intent warms the repository's cached documents.

`WorkbenchTab.terminalId` identifies the destination: the existing PTY id,
deterministic Run session id, `setup`, or `run:add`. Placement and sidebar
visibility belong to that tab. The workspace scope stores the independent main
and bottom-panel selections. `OPEN_WORKBENCH_TERMINAL` publishes placement and
both destinations atomically; registry and settings reconciliation update the
original workspace and prune only after an authoritative read of that kind.
Run navigation happens before the engine request; delayed attachment never
changes the user's newer selection.

Persistence retains `column3-tabs-by-scope-v1` and
`zeros:terminal-panel:sessions`. Their historical names are compatibility
contracts. Session lifecycle remains in the terminal store and engine. The
older active-terminal map remains readable for legacy setup/run cleanup; new
presentation selections live in the workbench scope. `terminalTabsInitialized`
seeds Setup once for an old scope and respects later tab closure. Existing
global panel height and expansion preferences retain their storage key.

`TerminalPanel` owns one deck across both placements. Each retained surface
portals into a stable host whose DOM can move between main, panel, and inert
parking containers. Changing the portal target itself would remount xterm.
The deck retains four workspace folders and at most twelve session views;
eviction detaches the view, while the engine keeps its PTY and replay buffer.
Hidden surfaces gate focus, measurement, Run shortcuts, and status reads.
Newly retained sessions defer PTY attachment until they have a visible host
with real dimensions; the font-metric fallback cannot attach a parked view.
Run overlays have a local stacking level so attaching a PTY after its overlay
cannot cover Stop/Rerun controls.

Closing a plain terminal closes its session while another plain shell remains.
The last shell's view can close while its session stays available in the
sidebar. Closing a Setup/Run tab closes its view without stopping work; stopping
or rerunning still requires the existing explicit controls. Owner deletion uses
the established workspace and terminal-store pruning paths.

`terminal-tabs.test.ts` and `workbench-reducers.test.ts` cover migration,
identity, atomic placement, exact workspace ownership, and reconciliation.
`pnpm test:ui-smoke` also exercises real xterm retention, keyboard navigation,
both resize seams, docking, Run races and controls, hidden effects, reload,
closing, and the terminal DOM bound using an in-memory transport. The lifecycle
smoke also covers boot folder restoration, hidden attachment, and configured
Run titles across sidebar and bottom-panel selection.
