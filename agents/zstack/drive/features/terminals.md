# Terminals and run sessions

**What it is.** A terminal is a workspace-scoped PTY, shown as a main workbench
tab or a bottom panel. Repository run commands have distinct run sessions.

**Reach.** Select the workspace, click **New File, Browser, or Terminal tab**,
then choose **Terminal**. The **Terminal sessions** list selects existing
sessions; **Move terminal to bottom panel** changes presentation.

**Drive.** In a real disposable workspace, run `printf 'zstack-drive\n'` and
check its output and cwd. Dock/undock the terminal, switch to workspace B and
return to A, and verify A's session and output are retained without cross-owner
input. Stop only a run you started and close only your created terminal.

**Linux fixture.** Open `harness-terminal-workbench.html`; wait for
`window.__zerosTerminalSmoke.sessions().length > 0`. Open a new Terminal and
wait for `.xterm-helper-textarea` to appear. Click **Move terminal to bottom
panel**; `[data-terminal-panel]` should become visible while the same terminal
remains selected. Repeat with `?organization-local` and `?cloud` in separate
contexts. The full driver is `scripts/ui-smoke-terminal-workbench.mjs`, scenario
`terminal-workbench`; it also checks session lifecycle and owner switches.

**Observable end state.** Output/input belongs to the selected workspace and
session, docking does not create a second PTY, and returning restores that
session. Capture the selected tab/session and output. Real process exit must be
observed through the actual runtime, not inferred from hiding a panel.

**Gotchas.** Fixture PTYs are in-memory and execute no shell. Cloud terminals
require a running workspace and wake only for explicit work; an idle shell must
not indefinitely prevent idle stop. Cloud has no Browser/Design/simulator
fallback to Local. A closed tab and a stopped run are distinct operations.

Sources: `apps/desktop/src/renderer/shell/workbench/tabs/terminal-tab.tsx`,
`apps/desktop/src/renderer/harnesses/harness-terminal-workbench.tsx`.
