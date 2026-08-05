# Tooltip inventory

Every tooltip currently in the app, one per line, grouped by surface. **Edit this file** —
delete/mark any line you want removed, or rewrite the label text — then tell me and I'll apply it.

- Format: `label` — `file:line` — trigger / note
- `⚠` = candidate you may want to remove next (tab-like · segmented control · raw path/name reveal)
- `{…}` = dynamic label (value shown at runtime)
- Behavior now: **open delay 500ms**, no insta-pop while sweeping (`skipDelayDuration=0`).
  Glass = `bg2/40` + `blur(10px)` + `saturate(1.7)`, 12px text. Primitive: `apps/desktop/src/renderer/shared/ui/primitives/tooltip.tsx`.
- **Focus guard**: tooltips never open from focus while the user is mousing (`getLastInputModality()`
  check in `TooltipTrigger`). Fixes the "stuck tooltip on overlay open" class — Radix focus-scope
  focuses the first tabbable inside a Popover/Dialog on open, and if that's a tooltip trigger the
  tooltip hung with no hover (model-picker ★ "Set as default", project-context-chip "Copy path",
  dispatcher-modal "Choose project"). Keyboard focus (Tab/arrows) still shows tooltips.

Already removed this pass: repo/project path hover (sidebar + topbar + settings), Code/Design toggle,
Dashboard, Create, Setup/Run/Terminal subtabs, workbench tabs, chat tabs, All Files/Changes/PR
tabs, settings sidebar tabs, workspace rows (earlier).

---

## Repository navigation · sidebar rail
- `Hide sidebar` / `Show sidebar` · ⌘B — `shell/workbench/toggle-button.tsx` — collapse toggle
- `Show panel` / `Hide panel` · ⌥⌘B — `shell/workbench/toggle-button.tsx` — workbench toggle
- `Add repository` — `shell/home-sidebar.tsx` — icon button
- `Archive workspace` — `shell/home-sidebar.tsx` — workspace-row hover action
- `Publish to GitHub` — `shell/home-sidebar.tsx` — project-header action
- `Repo settings` — `shell/home-sidebar.tsx` — project-header action
- `Create from…` · ⌘⇧N — `shell/home-sidebar.tsx` — project-header action
- `New workspace` / `Creating…` — `shell/home-sidebar.tsx` — project-header "+"
- `Filter projects` — `shell/home-sidebar.tsx` — section-header icon
- `Settings` — `shell/home-sidebar.tsx` — bottom rail icon
- `Toggle Sidebar` — `sidebar.tsx:286` — primitive SidebarTrigger

## Conversation pane · top bar + tabs
- `Target branch locked` / `Change target branch` — `shell/top-bar.tsx` — branch popover trigger
- `Open in…` — `shell/top-bar.tsx` — open-in-app dropdown
- `Click to rename` / `Project main checkout` — `shell/top-bar.tsx` — workspace name
- `New chat or terminal` — `shell/conversation/new-chat-menu.tsx` — "+" menu
- `{terminal agent name}` — `shell/conversation/new-chat-menu.tsx` — quick terminal button
- `Default agent` / `Set as default` — `shell/conversation/new-chat-menu.tsx` — star toggle
- `Rename chat` — `shell/conversation/chat-tabs.tsx` — chat-tab hover icon
- `Close chat` — `shell/conversation/chat-tabs.tsx` — chat-tab hover icon

## Workbench · terminal / browser / changes / files / review
- `Run · {command}` — `terminal-tab.tsx:355`, `run-control.tsx:30` — run button
- `New terminal` — `terminal-tab.tsx:427` — "+" icon
- `Back` — `browser-tab.tsx:946` · `Forward` — `:958`
- `Loading…` / `Reload` — `browser-tab.tsx:970`
- `Design Mode` · ⌘⇧D — `browser-tab.tsx:1016`
- `Canvas Mode` · ⌘\ — `browser-tab.tsx:1044`
- `More` — `browser-tab.tsx:1067` — browser actions menu
- ⚠ `{browser tab title}` — `browser-tab.tsx:795` — browser sub-tab (a tab)
- `{preset} ({width}px)` — `browser-tab.tsx:1148` — viewport preset
- `Reset to default height` — `browser-tab.tsx:1193`
- ⚠ `{element selector}` — `browser-tab.tsx:1322` — picked-element chip (raw selector)
- `Fork variant` / `Canvas mode only` — `browser-tab.tsx:1364`
- `Show all changes` — `changes-tab.tsx:1040`
- `No turns` — `changes-tab.tsx:1125`
- `Flat list` / `Folder tree` — `changes-tab.tsx:1152` — view toggle
- ⚠ `{oldPath → path}` — `changes-tab.tsx:1282` — renamed file (path reveal)
- ⚠ `{file path}` — `changes-tab.tsx:1294` — file row (path reveal)
- `{turn title}` — `changes-tab.tsx:1358` — turn group
- ⚠ `{file path}` — `file-viewer.tsx:138` — file header (path reveal)
- `Mark as viewed` / `Mark as not viewed` — `file-viewer.tsx:394`
- `Discard changes` — `file-viewer.tsx:415`
- ⚠ `Unified view` / `Split view` — `file-viewer.tsx:434` — segmented toggle
- `{PR title}` — `review-tab.tsx:165` — PR header (reveal)
- `Open on GitHub` — `review-tab.tsx:178`
- `Add to chat` — `review-tab.tsx:522`
- `Drag to resize` — `source-panel-resizer.tsx:303`
- `Collapse panel` / `Expand panel` — `source-panel.tsx:175`
- ⚠ `{workspace path}` — `worktree-missing-panel.tsx:83` — path reveal

## Agent chat · composer / turn / cards
- `Back to agents` — `agent-chat.tsx:2430`
- `Attach or link` — `agent-chat.tsx:2976`, `dispatcher-composer.tsx:240` — "+" menu
- `Stop agent` / `Save message` / `Send` · ↵ — `agent-chat.tsx:3045` — submit button
- `Save message` · ↵ — `agent-chat.tsx:3083` — queued-edit save
- `Create workspace` · ↵ — `dispatcher-composer.tsx:312`
- `Change model` — `composer-pills.tsx:167`, `agent-model-picker.tsx:118`
- `Adjust effort level` — `composer-pills.tsx:332`  (⌥T shortcut not wired — omitted)
- `Disable fast mode` / `Enable fast mode` — `composer-pills.tsx:379`
- `Exit plan mode` / `Enter plan mode` — `composer-pills.tsx:419`
- `Default model` / `Set as default` — `composer-pills.tsx:229`, `agent-model-picker.tsx:190`
- `Copy plan` — `plan-review-card.tsx:91`
- `Reject plan` — `plan-review-card.tsx:104`
- `Approve plan` · ⌘⇧↵ — `plan-review-card.tsx:115`
- `Project context files` — `project-context-chip.tsx:88`
- `Copy path` — `project-context-chip.tsx:145`
- ⚠ `{file path}` — `project-context-chip.tsx:155` — path reveal
- `Skips to default` — `question-card.tsx:323` — timeout countdown
- `Dismiss` — `question-card.tsx:337`
- `Submit` / `Answer all questions` · ↵ — `question-card.tsx:492`
- ⚠ `{queued message text}` — `queued-messages-card.tsx:129` — full-message reveal
- `{n} attachment(s)` — `queued-messages-card.tsx:135`
- `Save` / `Edit` / `Delete` / `Send now` / `Steering unsupported` — `queued-messages-card.tsx:248` (RowAction)
- `Edit message` — `turn-container.tsx:423`
- `Copy message` / `Copied` — `turn-container.tsx:434`
- ⚠ `{message timestamp}` — `turn-container.tsx:449` — time reveal
- `Attach file` — `turn-container.tsx:659`
- `Resend` · ↵ — `turn-container.tsx:683`
- `Agent run time` — `turn-footer.tsx:442`
- `Copy output` / `Copied` — `turn-footer.tsx:447`
- `Turn actions` — `turn-footer.tsx:463`
- ⚠ `{changed file path}` — `turn-footer.tsx:491` — path reveal
- `Jump to your prompt` — `jump-pills.tsx:70`
- `Jump to latest` — `jump-pills.tsx:98`
- ⚠ `{directory path}` — `added-directories.tsx:46` · `Remove` — `:54`
- `Close` — `use-composer-editor.tsx:777` — image-preview close
- ⚠ `{mention/file path or name}` — `composer-editor/pills.tsx:36`, `pill-views.tsx:32/73/90` · `Remove` — `pills.tsx:53/124`
- ⚠ `{attachment name/info}` — `composer-attachments.tsx:80/122`, `pills.tsx:88`
- `Dismiss` / `Close terminal` — `embedded-terminal-command.tsx:176`
- ⚠ `{attachment name}` — `text-message.tsx:277/301` — reveal

## PR
- `Create PR` — `create-pr-button.tsx:127`
- `More PR options` — `create-pr-button.tsx:143`
- `Show pull request` — `pr-status-island.tsx:243`
- `{PR action label}` — `pr-status-island.tsx:271` · `dashboard-page.tsx:543` (dynamic)

## Dispatcher / dialogs
- `Create from source` — `create-from-source.tsx:138`
- `Coming soon` — `create-from-source.tsx:206`, `create-from-picker.tsx:351`, `quick-start.tsx:320`
- `Clear base` — `create-from-source.tsx:256`
- `Choose project` — `dispatcher-modal.tsx:203`
- `Add a project` — `dispatcher-modal.tsx:239`

## Panels · settings / MCP / providers / repos / org
- `Help` — `help-menu.tsx:48`
- `Import servers` — `mcp-panel.tsx:1158`
- `Show tools` — `mcp-panel.tsx:687`
- `{gateway status/error}` — `mcp-panel.tsx:702` (dynamic diagnostic)
- `Sign in` — `mcp-panel.tsx:709`
- `Authorize on another device` — `mcp-panel.tsx:727`
- `Edit` — `mcp-panel.tsx:746` · `Remove` — `:172/:751`
- `Copy to this layer` — `mcp-panel.tsx:817`
- `{server warning}` — `mcp-import-dialog.tsx:315` (dynamic)
- `Copy install command` — `providers-panel.tsx:817`
- `Refresh` — `providers-panel.tsx:968`
- `Close terminal` — `providers-panel.tsx:1288`
- ⚠ `{settings.toml path}` — `repositories-panel.tsx:322` — path reveal
- `Remove variable` — `repositories-panel.tsx:742`
- `Stored in Keychain` / `Store in Keychain` — `repositories-panel.tsx:716`
- ⚠ `{repo root path}` — `repositories-panel.tsx:1161` — repo path reveal (Root-path row)
- `Revoke invitation` — `organization-panel.tsx:453`
- `Delete secret` — `organization-panel.tsx:559`
- `Leave organization` / `Remove {name}` — `organization-panel.tsx:776`
- `Delete team` — `organization-panel.tsx:858`
- `Back to app` — `settings-page.tsx:547`
- `{layer hint}` — `settings-page.tsx:571` — Edit settings.toml button (short-formed)
- ⚠ `{You/Team layer hint}` — `settings-page.tsx:893` — layer segmented toggle
- `Hide` / `Show` — `github-section.tsx:207` — PAT visibility
- `Unarchive` — `dashboard-page.tsx:386`
- `Open PR on GitHub` — `dashboard-page.tsx:560`
- `Remove agent` — `terminal-agents-section.tsx:421`
