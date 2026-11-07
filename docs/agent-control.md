# Agent control

Agents can drive things on the user's Mac through Zeros: the in-app browser,
Mac apps and simulators. This guide owns which browser each agent uses, the
`zeros_browser` tools, approvals, the control bar, Stop, Local versus cloud
behavior, and the staged rollout of these features.

Related guides:

- [Browser service](browser-service.md) owns page hosting, isolation, the
  loopback service and artifacts.
- [Computer use](native-computer-use.md) owns the Cua driver runtime, the
  disabled Codex plugins and macOS permissions.
- [Simulators](simulators.md) owns the Simulator tab and the `zeros_device`
  tools, which follow the approval, control bar and Stop rules here.

## Which browser each agent uses

One function applies the table: `resolveBrowserRoute` in
`packages/protocol/src/browser-tools.ts`. The engine calls it when a provider
boots and again on every `zeros_browser` call, so a Settings change applies to
a running agent. Settings and the Browser session controller use the same
function, so the UI never disagrees with the engine.

| Agent  | Route                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------- |
| Codex  | `zeros_browser`. Codex never uses its built-in Browser plugin.                                     |
| Claude | Claude in Chrome (`claude-chrome`) when "Use Claude Code with Chrome" is on, else `zeros_browser`. |
| Cursor | `zeros_browser`.                                                                                   |

"Enable browser use" decides for every agent: off, no agent gets a browser,
Claude's Chrome included. While the Zeros browser rollout is closed, only
Claude's chosen Chrome remains.

The settings live in the engine-owned `[browser]` table, which only the user
and managed layers may set. Every key has a row in Settings > Browser:

| Key              | Default | Meaning                                                                |
| ---------------- | ------- | ---------------------------------------------------------------------- |
| `enabled`        | `true`  | "Enable browser use": agents may use a browser.                        |
| `claude_enabled` | `false` | "Use Claude Code with Chrome": Claude uses Chrome, not the in-app one. |
| `auto_open`      | `true`  | "Open the Browser tab automatically" when any agent starts browsing.   |

The agent's pointer follows `[computer_use] show_agent_cursor` ("Show agent
cursor" in Settings > General). Retired keys (`codex_enabled`,
`in_app_enabled`, `codex_native`, `provider`, `show_agent_cursor`,
`navigation_approval`, and `[computer_use]` `app_access` and `codex_native`)
have no effect except through the keys that replaced them. Each layer is folded
as it is read (`settings/retired-agent-control.ts`), so an opt-out stays in
force, and locked, in the layer that set it, managed included: a browser denied
to any agent stays off for every agent, and a hidden pointer hides the agent
cursor. Zeros no longer asks before opening a website, so a managed
`navigation_approval = "always-ask"` turns browser use off instead of dropping
the question; in the user's own file it is ignored. The engine removes the
retired keys from the user's file at start (`settings/agent-control-migration.ts`).

Electron main closes every in-app page when browser use is off. Codex's
bundled Browser and Chrome plugins are disabled on every Codex thread.

## `zeros_browser` tools

`AgentControlToolAdmissions` (`apps/desktop/src/engine/agent-control/admission.ts`)
admits the tools per agent execution through the session tool factory. It
serves them as a loopback MCP server named `zeros_browser`, with the same
bearer token and Host/Origin checks as the Design MCP server. The token
reaches the provider only through `ZEROS_BROWSER_TOOLS_CAPABILITY`. The
browser service's own credential stays in the engine.

The tools are `open`, `snapshot`, `click`, `type`, `key`, `select`, `scroll`,
`wait`, `upload`, `resize`, `back`, `forward`, `reload`, `screenshot`, `trace`
and `close`, defined once in `BROWSER_TOOL_DEFINITIONS`. Element references
are valid only for the latest snapshot.

`ZerosBrowserTools` (`zeros-browser-tools.ts`) binds every call to the
admitted workspace and conversation; tool arguments never choose either. It
acquires the conversation's browser session, the same page the Browser tab
shows. A call fails once the workspace is archived, moved or
re-placed. Each call names the agent family to the browser host, which shows
it in the control bar.

When a provider turn that used the browser ends, `endPrompt` sends `close`:
a handoff that keeps the page, its history and cookies, and returns control
to the user.

## Shell commands

Agents reach for their shell first, so every chat admitted for the Zeros
browser or computer use also gets `zeros browser …` and `zeros computer …` on
`PATH` (the shared `zeros` launcher, `pathPrepend`). Each command is one
`POST /call {name, arguments}` to that chat's existing agent-control server,
beside `/mcp`, with the same bearer (`ZEROS_*_TOOLS_CAPABILITY`) and a
`ZEROS_COMPUTER_TOOLS_URL` / `ZEROS_BROWSER_TOOLS_URL` for the route. Admission,
blocked apps, the control bar, Stop and the per-turn lease are therefore
exactly the tools'. `/call` refuses any request with an `Origin`.

One command can resolve an app by name, open a URL in it without taking focus
(`open_url`, Launch Services `open -g -b`), wait for a window title, and save
screenshots to files; `batch` runs several steps in one process. Browser reads
are compacted to about 2,000 characters with refs kept (`--find`, `--full`).
The CLI lives in `apps/desktop/src/engine/agent-control/control-cli.ts`; a
one-line brief before each turn names it. A sandboxed shell that cannot open
the loopback connection is told to use the tools instead.

## Approvals

Agents use any app that is not blocked, without a card, and open websites
without asking. Sign-in, payment, publishing, destructive actions, form
submission, uploads, downloads and browser permissions still go through the
browser host's confirmation broker. Each request appears as a
`PermissionCard` in the owning chat. Claude skips its own per-call tool card
for the engine-registered `zeros_browser` server, because the host already
asks before risky actions; a project or plugin server with the same name
keeps the normal card. Codex gets the same: the engine registers
`zeros_browser`, `zeros_computer` and `zeros_device` with
`default_tools_approval_mode = "approve"`, so Codex does not add its own
approval for each call.

## The control bar

While an agent owns a page attached to the Browser tab, a compact control bar
sits at the bottom center of the page. It names the agent ("Codex", "Claude
Code", "Cursor"), says what it is doing, and offers Stop with an `esc` hint.
Picture in picture keeps its own hover strip; both use `AgentControlBar`
(`apps/desktop/src/renderer/features/agent-control/agent-control-bar.tsx`).

A live page is a native `WebContentsView` above the renderer, so the bar is a
separate transparent view stacked directly above the page
(`apps/desktop/electron/agent-control/overlay.ts`). Its page is the second
Vite entry, `agent-control.html`, with a preload that exposes only two
capabilities: receive what to show, and ask main to stop. Because the bar is
its own view, page screenshots never contain it.

- The bar follows agent ownership for the whole turn, like the page input
  lock, and fades out (about 120 ms, none with reduce motion) when control
  returns in place.
- It is removed at once when the page leaves the tab, so it never floats over
  renderer UI, and while the page is in picture in picture.
- An off-screen bar keeps its renderer for 30 seconds, then releases it.
- The view takes the pointer across its whole rectangle; that costs nothing
  because the page refuses direct input during an agent turn anyway.

## Stop and Esc

- **Composer Stop** ends the turn and all control: pending `zeros_browser`
  calls fail and the page's current action is interrupted.
- **The control bar's Stop, the Browser tab's Stop, and picture in picture's
  Stop** end only the agent's control of the page. The provider turn
  continues and can report the stopped tool.
- **Esc** pressed by the user inside an agent-owned page, or while the bar has
  focus, works like the bar's Stop. Keys the agent sends itself pass through
  (`browserInputStopsAgent`), so an agent can still press Esc in a page.

Stopping from the page or the bar emits `browser-agent-stopped`, so the
renderer can dismiss that chat's pending Browser approval; the Browser tab's
own Stop does this directly.

## Transcript

`zeros_browser` calls render as Browser activity rows with inline screenshots,
whichever agent made them, through `groupBrowserToolActivity`. See [Tool presentation](agent-tool-presentation.md).

## Local and cloud

Everything here runs on the user's Mac, in Local and organization-local
workspaces. Admission returns no tools for the cloud worker, cloud placements,
archived workspaces, or an engine without a browser service. Cloud workspaces
keep their existing browser unavailability contract in
[Browser service](browser-service.md#organization-cloud-availability-and-compatibility).
Organizations can lock every switch above through managed settings.

## Rollout

Four features reach users in stages through this table: the Zeros browser
(`zeros_browser` for every agent), Zeros computer use, simulators, and the [Zeros Local CLI](local-cli.md)
(`localOrchestration`). The Codex browser fixes ship to everyone and have no
gate. `AGENT_CONTROL_ROLLOUT` in
`packages/protocol/src/agent-control-rollout.ts` sets each feature's stage,
so moving a feature to its next stage changes only that table.

| Stage          | Who has the feature                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `internal`     | Staff accounts and unpackaged local development builds, through a Settings → Internal switch that starts on. |
| `experimental` | Anyone who turns on the feature's Settings → Experimental switch, which starts off.                          |
| `default`      | Everyone, with no switch.                                                                                    |

All four features are `default`: available to every user without an Internal
or Experimental switch. Previously saved rollout opt-outs no longer disable
them. Their normal Settings, approvals, managed policy and workspace support
still apply: cloud does not gain Browser, computer use or simulators, and
Zeros Local CLI remains scoped to Personal Local workspaces.
Computer use also defaults on in normal settings; existing explicit opt-outs
remain off. Accessibility, Screen Recording and blocked apps still apply
before an agent can control an app.

The Internal tab instead offers a default-on Resource summary switch for
authorized internal users. It shows live full-app memory in the sidebar and
opens the resource inspector. Sampling pauses when the window is hidden or
unfocused, the sidebar is hidden, or the Internal switch/access is disabled.

Each non-default stage has one rollout switch; it does not replace a feature's
own Settings, approvals or managed policy.

A closed feature behaves as Zeros did before it:

- **Zeros browser:** no agent gets the in-app browser; Claude Code keeps
  Claude in Chrome when that is on. Pages get no control bar, and Esc in an
  agent-owned page does not stop the agent.
- **Computer use:** the Computer use section of Settings → General is hidden,
  no agent gets `zeros_computer` tools, and Electron main refuses computer use
  calls.
- **Simulators:** Settings → Simulators and the "+" menu entries are hidden,
  a restored Simulator tab says simulators aren't available, a dropped video
  attaches without key frames, and agents get no `zeros_device` tools.
- **Zeros Local CLI:** new executions get no `ZEROS_LOCAL_*` environment, no
  launcher on `PATH` and no `zeros_local` tool, and calls from executions
  admitted earlier fail with "Zeros Local CLI isn't available in this copy of
  Zeros." "Copy link" is hidden. A push without the `localOrchestration` key
  (an older renderer) still applies and keeps it closed.

The renderer decides (`useAgentControlAvailability` in
`apps/desktop/src/renderer/features/settings/agent-control-rollout.ts`), and
`BrowserSessionController` sends the result to Electron main with
`agent_control_availability_update`. Main applies it to the control bars,
computer use and simulator calls, then hands it to the engine over the
private stdin pipe as `host.agentControlAvailability`. The command resolves
only after the engine confirms, and provider capability refreshes wait for
it, so an agent that restarts for a route change boots with the new answer.

The engine applies it to every route (`browserRouteForWorkspace`,
`computerUseRouteForWorkspace`, `deviceToolRouteForWorkspace`), to admission
and to every tool call's policy (`admission.ts`). A call to a closed feature
fails with text that names no switch, such as "Simulators aren't available in
this copy of Zeros." Until the renderer's first push, main and the engine
open only `default` features, and every engine main spawns starts from main's
latest copy. Cloud workers ignore the message, because they serve none of
these tools.

## Verification

- `packages/protocol/src/__tests__/browser-tools.test.ts`: the routing table
  and agent names.
- `apps/desktop/src/engine/agent-control/__tests__/zeros-browser-tools.test.ts`:
  admission, policy per call, Stop, turn-end handoff and the agent name.
- `apps/desktop/electron/__tests__/agent-control-overlay.test.ts` and
  `browser-surface.test.ts`: the bar's stacking, fades, release and Esc rules.
- `pnpm smoke:browser-service` (macOS): the bar shows the agent's name over an
  attached page, agent keys pass through, user Esc stops the agent and reports
  it, picture in picture and detaching remove the bar, and a closed Zeros
  browser rollout removes the bar and Esc's stop.
- `packages/protocol/src/__tests__/agent-control-rollout.test.ts` and
  `apps/desktop/src/renderer/features/settings/__tests__/agent-control-rollout.test.ts`:
  stages, switches, strict reads and the closed routes.
- `apps/desktop/src/engine/agent-control/__tests__/rollout.test.ts` and
  `apps/desktop/src/engine/__tests__/agent-control-availability-host.test.ts`:
  engine routes, admission, per-call refusal and the host message.
