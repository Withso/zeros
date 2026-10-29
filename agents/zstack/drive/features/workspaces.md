# Workspace navigation and owners

**What it is.** The sidebar selects a repository/workspace within the current
owner. Local Personal and organization-local workspaces use local paths;
organization cloud workspaces use cloud identities and their own runtime.

**Reach.** In the native app, use **Switch organization** to select Local or an
organization, expand a repository, then select a workspace row. Account-free
`electron:local` exposes Local only; organization flows need the authorized
signed-in stack.

**Drive.** Open workspace A, select a file or tab, visit B, then return to A.
The selection should restore for A. Repeat across owners when available. Try
**Filter workspaces** and repository collapse without losing the active row.
Use **Create workspace in <repository>** only when creating a disposable
workspace is part of the task; creation can run setup and, for cloud, start a VM.

**Linux fixture.** Open `harness-app-sidebar.html`; wait for
`[data-workspace-id="ws-new-york"]`. Select
`[data-workspace-id="ws-boston"]`, then New York, then Boston again. Observe
the active row and the fixture destination through `window.appSidebarState()`.
The controls are the production sidebar; destination/creation callbacks are
fixtures. The broader driver is `scripts/ui-smoke-app-sidebar.mjs`, scenario
`app-sidebar`. Owner selection has separate `personal-organization` coverage.

**Observable end state.** Exactly the intended workspace is active, its
destination is published together with its identity, and returning restores its
own selection. A late response for another owner must neither render nor clear
this owner's view. Capture the selected row and destination together.

**Gotchas.** A cloud VM's `/home/user/...` path is not its renderer identity.
Stopped and archived are separate states; passive history reads must not wake a
VM. Sidebar fixture success does not prove creation, wake, Git setup or native
durable state. Native Local cannot prove organization or cloud behavior.

Sources: `apps/desktop/src/renderer/shell/app-sidebar.tsx`,
`apps/desktop/src/renderer/features/team/organization-switcher.tsx`,
`apps/desktop/src/renderer/harnesses/harness-app-sidebar.tsx`.
