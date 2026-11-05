# Settings: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Settings”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Settings window · Local, General (`SetWindowLocal`)

Owner today: `features/settings/settings-page.tsx (SettingsPage, GeneralPanel, PrivacyGroup) · settings-ui.tsx · follow-up-behavior-setting.tsx · keep-awake-setting.tsx`

Changes:
- The Settings window and the web dashboard now share one shell: 256px sidebar, 32px rows, 12px group labels, a 640px column.
- A 40px title bar on both sides; Open settings.toml sits in the title row, on the column edge, instead of a strip that pushes the title 84px down.
- The org switcher is a 32px nav row on the same 16px icon column as the rows (it sat at 13px).
- Nav rows are 13/18 like the panels (14/20 today); group labels are 12 medium fg3.
- The select is the fixed 160px width; rows are 12 × 14 with 13 medium names and 12 fg3 hints.

Code notes:
- Title strip: the h1 sits 84px from the top in Local (16px strip, 28px Open settings.toml, 40px) but 56px in Organization, and the file button aligns to the pane gutter, not the column. (`features/settings/settings-page.tsx:599-606,683-688,700`)
- The org switcher is 30px with its icon at x 17px while nav icons sit at 22px; it is 13px medium against the rows’ 14px. (`features/team/organization-switcher.tsx:153 · features/settings/settings-page.tsx:434`)
- The nav sits outside .settings-type-scale, so rows are 14/20 while every panel is 13px; group labels are 13px muted with 20 / 6px padding. (`features/settings/settings-page.tsx:434,437,700`)
- Trailing selects come in three widths (128px, min 160px, fit), so stacked triggers have ragged edges; Select width="fixed" has no callers. (`features/settings/follow-up-behavior-setting.tsx:18 · shared/ui/primitives/select.tsx:86-89 · features/settings/settings-page.tsx:1168,1518,1541`)
- 13px text sits on four line heights (17.9, 18, 18.57 and 21.1px), so a label with a two-line hint is 62.1px tall, off the 4px grid. (`features/settings/settings-page.css:5-7 · features/settings/settings-ui.tsx:178,199,227`)

## Settings window · Organization, Agents (`SetWindowOrganization`)

Owner today: `features/settings/settings-page.tsx · settings-section-availability.ts · cloud-provider-connections.tsx · team/organization-switcher.tsx`

Changes:
- One-item groups (Integrations, Cloud Computer) drop their 44px labels for a hairline.
- Each agent is a titled group card; the description that repeated three times is said once under the title.
- Disconnect moves into the ⋯ menu beside Configure; Connect is a compact secondary.
- The cloud browser note shows once at the end instead of under every agent.

Code notes:
- One-item groups (Organization holds only Integrations, Workspace only Cloud Computer) each spend a 44px label block. (`features/settings/settings-page.tsx:307-324,643-650 · features/settings/settings-section-availability.ts:16-27`)

## General · Keep awake (`SetKeepAwake`)

Owner today: `features/settings/keep-awake-setting.tsx · keep-awake-settings.ts · keep-awake-controller.tsx`

Changes:
- Settings cards: 12 × 14 rows, names 13 medium, hints 12 fg3, controls right-aligned at 28.
- Switch thumb sits 2px inside the track with one soft shadow.

Code notes:
- Error state: a 24px compact Retry sits beside a 20px switch in a card whose other controls are 28px. (`features/settings/keep-awake-setting.tsx:17-24`)

## General · Full Disk Access (`SetFullDiskAccess`)

Owner today: `features/settings/full-disk-access-row.tsx · full-disk-access-state.ts`

Code notes:
- Status slot: Granted plus a 12px gap that stays when the status is empty; Computer use says On instead. (`features/settings/full-disk-access-row.tsx:69-83 · features/settings/computer-use-panel.tsx:444-455`)

## Send feedback (`HomeFeedback`)

Owner today: `shell/dialogs/feedback-dialog.tsx · features/feedback/feedback-types.ts`

Changes:
- Dialog: border2, 12px corners and a 16px inset; a 24px close, Ghost Cancel, and the footer rule retires.
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.
- Fields: 13/18 text, 8px padding, no shadow; clicking in and typing change nothing.
- Selects: 13/18 with 8 / 6 padding and a muted chevron that turns fg2 on hover.
- Primary actions drop the stock shadow.

Code notes:
- Feedback dialog: 448px wide, 14px labels with leading-none 6px above fields, a native 14px checkbox, View forced to 24px, and Send renders Secondary because it has no variant. (`shell/dialogs/feedback-dialog.tsx:91,99-154,171 · shared/ui/primitives/label.tsx:8`)
- Inputs and textareas pad 12px with shadow-sm while selects and buttons pad 6px, so stacked field text starts 6px apart. (`shared/ui/primitives/input.tsx:17 · shared/ui/primitives/textarea.tsx:15 · shared/ui/primitives/select.tsx:97 · shell/dialogs/feedback-dialog.tsx:106,121`)
- Label-to-field is 6 or 8px, field gaps run 12–28px, and dialog inputs render 14px outside the type scale. (`features/agent-extensions/customize-mcp.tsx:167-216 · shell/dialogs/feedback-dialog.tsx:99-129 · features/agent-extensions/customize-extensions.tsx:94-125 · features/settings/providers-panel.tsx:915-962`)
- Dialog widths are 384, 448 and 512px; the main action is destructive, primary or Secondary when the variant is left out. (`shared/ui/primitives/dialog.tsx:169 · features/settings/cloud-credential-removal-dialog.tsx:14,20-21 · shell/dialogs/feedback-dialog.tsx:91,171`)

## General · All states (`States_settings_general`)

Composite board: implemented through the boards it imports.

## Appearance · Theme and code (`SetAppearance`)

Owner today: `features/settings/settings-page.tsx (AppearancePanel, THEME_OPTIONS) · code-theme-preview.tsx · shared/theme/code-themes.ts`

Code notes:
- Two fit-width selects end at different widths; preview line numbers start at 20px while labels sit at 12px, and preview lines are 20.8px. (`features/settings/settings-page.tsx:1518,1541,1556-1558 · features/settings/code-theme-preview.tsx:31-34`)

## Experimental · Features (`SetExperimental`)

Owner today: `features/settings/settings-page.tsx (ExperimentalPanel) · experimental-features.ts`

Code notes:
- Panel intros: a loose 13px paragraph 24px above an untitled card (Experimental); the Codex note touches its card with 0px gap. (`features/settings/settings-page.tsx:1245-1251,1380-1383`)

## Profile · Signed in (`SetProfile`)

Owner today: `features/settings/settings-page.tsx (AccountPanel, SignInMethodRow) · account-authentication-provider.ts`

Code notes:
- The group title Sign out repeats its first row; Sign out everywhere hand-tints a secondary button instead of using destructive-secondary. (`features/settings/settings-page.tsx:927-957 · shared/ui/primitives/button.tsx:48-49`)
- Five empty-state recipes, from an unboxed 14px line to a 144px bordered card and a 96px dashed button. (`features/settings/settings-ui.tsx:253,269 · features/repositories/files-to-copy-section.tsx:385,402 · features/agent-extensions/customize-mcp.tsx:505 · features/agent-extensions/customize-extensions.tsx:388,398`)
- Five destructive patterns: a ghost Delete, a hand-tinted secondary, an instant red-hover trash, an inline text confirm and a dialog with two Secondary buttons. (`features/settings/settings-page.tsx:956,1300-1312 · features/repositories/repositories-panel.tsx:624 · features/agent-extensions/customize-mcp.tsx:414,764 · features/settings/cloud-credential-removal-dialog.tsx:20-21`)
- Two header systems: SettingsGroup (12px fg2 + 12px muted, 8px above) and SettingsSection (14px fg1 + 13px fg2, 12px above). (`features/settings/settings-ui.tsx:49-56,106-116`)

## Integrations · GitHub connected (`SetGitHub`)

Owner today: `features/settings/github-section.tsx (GitHubSection, IdentityBadge, MethodIcon) · github-connection-model.ts`

Changes:
- Cards and tiles round to 12; hover lifts to border3 + bg2-highlight.
- A chosen radio fills inverted-bg with a 6px inverted-fg dot.

Code notes:
- Method cards: 6px radius, 14px padding and a 66px minimum (off the grid); the card grows when a 24px badge replaces the 13px description. (`features/settings/github-section.tsx:172,667,698-713`)
- Two method-card builds: 14px vs 13px labels and muted vs fg2 footnotes; the cloud header packs up to three 28px text buttons and its alert icon rides high. (`features/settings/github-section.tsx:636-641,698,1101 · features/settings/cloud-github-section.tsx:151-153,199,217-268`)
- Six chip builds, from 10px text with 4px padding to 24px semibold badges. (`features/settings/settings-ui.tsx:317 · features/settings/providers-panel.tsx:459 · features/agent-extensions/customize-mcp.tsx:306,471 · shared/ui/primitives/badge.tsx:7 · features/settings/github-section.tsx:172`)
- Trailing glyphs are 12, 14 or 16px with 1, 1.5 or 2px strokes, and ghost text is fg2 in some panels and fg1 in others. (`features/settings/browser-use-panel.tsx:339,349 · features/settings/computer-use-panel.tsx:489,537 · features/repositories/repositories-panel.tsx:565-571 · shared/ui/primitives/button.tsx:40`)

## Integrations · GitHub setup (`SetGitHubSetup`)

Owner today: `features/settings/github-section.tsx (setup cards) · inline-login-terminal.tsx · use-github-login.ts`

Code notes:
- A bordered 6px sub-card nests inside the 6px method card; its h3 is 13px against a 14px label; Cancel is inline for CLI and App but on its own row for PAT. (`features/settings/github-section.tsx:821-1033`)

## Integrations · Needs attention (`SetGitHubAttention`)

Owner today: `features/settings/github-section.tsx (HealthDetail, GITHUB_HEALTH_LABEL, IdentityBadge)`

Changes:
- A connection that needs you is one 32px row in its card: a tone icon and one line, no filled box.

Code notes:
- The HealthDetail notice is bg1-highlight inside a bg1-highlight card, so only its 12px inset shows. (`features/settings/github-section.tsx:212,669`)

## Integrations · Disconnect GitHub App (`SetGitHubDisconnect`)

Owner today: `features/settings/github-section.tsx (disconnectAppOpen dialog)`

Changes:
- One line says what happens; the three bullets retire.

Code notes:
- The dialog list renders 14px (portaled outside the type scale) under a 13px description. (`features/settings/github-section.tsx:1149`)

## Integrations · Cloud GitHub (`SetCloudGitHub`)

Owner today: `features/settings/cloud-github-section.tsx (CloudGithubSection) · cloud-github-health.ts`

Code notes:
- Icon-only refresh buttons use the default size and render about 28 × 24. (`features/settings/cloud-github-section.tsx:155-165 · features/settings/cloud-repository-picker.tsx:117-123`)

## Integrations · All states (`States_settings_integrations`)

Composite board: implemented through the boards it imports.

## Models · Defaults and Claude (`SetModels`)

Owner today: `features/settings/settings-page.tsx (ModelsPanel) · claude-provider-settings.tsx · features/agent/reliability-settings.ts`

Changes:
- Segmented: 28 track, 24 items; selected is bg1 + border2 in Light, bg4 with no edge in Dark.

Code notes:
- The agent and model selects share one trailing slot, so a long model name reflows the label column; Automatic is static text in a control slot. (`features/settings/settings-page.tsx:1166-1206,1212`)
- Provider tabs are a 36px segmented list with 26.6px pills and an 8px bottom margin; Agents uses 36px underline tabs, Customize a 32px segmented control. (`features/settings/settings-page.tsx:1236-1239 · shared/ui/primitives/tabs.tsx:27,52 · features/settings/providers-panel.tsx:451`)
- A second card recipe (SETTINGS_CARD_LIST_CLS, MODELS_SECTION_CLS) is 8px round and, outside the group context, renders 14px names; Models cards sit 16px apart, not 24. (`features/settings/settings-ui.tsx:72-73,89,174-179 · features/settings/settings-page.tsx:1025-1026,1163-1164 · features/settings/git-defaults-section.tsx:173`)

## Models · Codex memory (`SetModelsCodex`)

Owner today: `features/settings/settings-page.tsx (ModelsPanel, Codex memory, resetMemoryOpen)`

No change beyond the shared foundation and primitives.

## Agents · Connected (`SetAgentsConnected`)

Owner today: `features/settings/providers-panel.tsx (ProviderTabs, ProviderSection, AgentConfigCard) · provider-information.tsx · connection-methods.ts`

Changes:
- Progress: a 4px border3 track with an fg1 fill.

Code notes:
- No card system: a flat header, a bordered 8px info card, flat 14px fields 44px apart and an 8px config card, with blocks 32px apart. (`features/settings/providers-panel.tsx:396,809,1050-1128 · features/settings/provider-information.tsx:135-146`)
- Hand-rolled 36px underline tabs (copied as TAB_CLS); + Add agent is a separate 36px text button outside the strip. (`features/settings/providers-panel.tsx:437-466 · features/settings/terminal-agents-section.tsx:273-341`)
- Loading is an empty 96px box, a 13px line, 14px text or a spinner; errors are 13px red in Settings and 14px in MCP and Skills. (`features/settings/providers-panel.tsx:398 · features/agent-extensions/customize-mcp.tsx:854-861 · features/agent-extensions/mcp-organization-page.tsx:82 · features/agent-extensions/customize-extensions.tsx:293,307-311`)

## Agents · Not installed (`SetAgentsInstall`)

Owner today: `features/settings/providers-panel.tsx (installHint, handleRunInstall) · provider-information.tsx`

Code notes:
- The install command is proportional 13px with break-all; Copy is placed absolutely 8px in with a 4px radius, and a 28px Run inside the h2 makes the title line 28px. (`features/settings/providers-panel.tsx:817-858`)

## Agents · Connect with account (`SetConnectionAccount`)

Owner today: `features/settings/provider-connection-dialog.tsx · subscription-connection-panel.tsx · connection-methods.ts`

Code notes:
- Account rows indent radios 24px with 4px vertical padding (36px rows) and use a 16px MoreVertical glyph. (`features/settings/subscription-connection-panel.tsx:162-205`)
- Method bodies: the API form adds 14px padding inside the 16px body (30px insets), and status lines switch between 14px fg1 and 13px fg2. (`features/settings/providers-panel.tsx:910,919 · features/settings/provider-connection-dialog.tsx:104-111 · features/settings/subscription-connection-panel.tsx:143`)
- The method picker is a third radio style (a hand-drawn 16px ring) in 44px headers, and the footer holds a disabled full-width Custom Providers (Coming soon). (`features/settings/provider-connection-dialog.tsx:76-128 · shared/ui/primitives/radio-group.tsx:67,79`)

## Agents · Connect with CLI (`SetConnectionCli`)

Owner today: `features/settings/provider-connection-dialog.tsx · providers-panel.tsx (cliOpen) · inline-login-terminal.tsx`

Code notes:
- Inline terminal header padding is 14 × 8px (off the grid) with 14px text; Paste is 14px but Close 16px, and the body is a fixed 300px. (`features/settings/inline-login-terminal.tsx:134-188`)

## Agents · Connect with API key (`SetConnectionApi`)

Owner today: `features/settings/providers-panel.tsx (apiKeyStatus, handleSaveApiKey) · provider-connection-dialog.tsx`

No change beyond the shared foundation and primitives.

## Agents · Organization connect (`SetCloudConnect`)

Owner today: `features/settings/cloud-provider-connections.tsx (CloudProviderConnection) · provider-connection-dialog.tsx · cloud-provider-sign-in.ts`

Code notes:
- Saved accounts are loose rows with a bottom hairline, the last row too; Cancel and Connect sit inside the method body and Connect renders Secondary. (`features/settings/cloud-provider-connections.tsx:80,307,352-391,488-541`)

## Agents · Remove connection (`SetCredentialRemoval`)

Owner today: `features/settings/cloud-credential-removal-dialog.tsx · cloud-credential-removal-controller.ts`

Changes:
- Ghost No and a destructive Yes, remove, 16px under the description (they sat on the footer rule).

Code notes:
- There is no DialogBody, so the description sits on the footer border; the dialog is 384px and No and Yes, remove are both Secondary. (`features/settings/cloud-credential-removal-dialog.tsx:14-22 · shared/ui/primitives/dialog.tsx:213,239`)

## Agents · All states (`States_settings_agents`)

Composite board: implemented through the boards it imports.

## Browser · Browser use (`SetBrowser`)

Owner today: `features/settings/browser-use-panel.tsx (BrowserSwitchRow) · browser-use-settings.ts · features/agent/native-browser-availability.tsx`

Code notes:
- Cards sit 12px apart even between titled groups, and only the first card has a heading. (`features/settings/browser-use-panel.tsx:309-356 · features/settings/computer-use-panel.tsx:416-498 · features/settings/simulators-panel.tsx:216-233`)
- The first group title repeats the h1 (Browser / Browser use, Computer use / Computer use). (`features/settings/browser-use-panel.tsx:315 · features/settings/computer-use-panel.tsx:417 · features/settings/simulators-panel.tsx:217 · features/settings/cloud-computer-panel.tsx:167`)

## Computer use · Permissions and apps (`SetComputerUse`)

Owner today: `features/settings/computer-use-panel.tsx (BlockedAppRow) · computer-use-settings.ts`

No change beyond the shared foundation and primitives.

## Simulators · Setup (`SetSimulators`)

Owner today: `features/settings/simulators-panel.tsx (SetupRow) · simulator-settings.ts · features/simulators/simulator-setup-model.ts`

No change beyond the shared foundation and primitives.

## Terminal Agents · Launch profiles (`SetTerminalAgents`)

Owner today: `features/settings/terminal-agents-section.tsx (TerminalAgentTabs, TerminalAgentCard) · terminal-agents.ts`

Code notes:
- Flat form: fields 28px apart, Save 4px under the last field, and an icon Remove about 30 × 26 with a 16px glyph beside a 28px Save. (`features/settings/terminal-agents-section.tsx:198,250,387-452`)

## Agents · All states · Proposed (`States_settings_agents_proposed`)

Composite board: implemented through the boards it imports.

## Cloud Computer · Build (`SetCloudComputer`)

Owner today: `features/settings/cloud-computer-panel.tsx (StatusSummary, HistoryRow) · cloud-computer-model.ts (computerStatus)`

Code notes:
- Repository: a 6px border3 input sits on a 4px border1 code textarea with a bg1 strip; errors float 24px above the card. (`features/settings/cloud-computer-panel.tsx:171-172,218-222 · shared/ui/primitives/code-textarea.tsx:45,50`)

## Cloud Computer · Build history (`SetCloudComputerHistory`)

Owner today: `features/settings/cloud-computer-panel.tsx (HistoryRow, BUILD_ICON) · cloud-computer-model.ts (historyNote)`

Changes:
- Badges are 20 tall, 12/16 medium, 4px corners.

Code notes:
- The History toggle insets 6px past the status text; rows are 40 or 44px depending on a 24px badge or a 28px button. (`features/settings/cloud-computer-panel.tsx:186-201,270-283`)

## Cloud Computer · Repository picker (`SetCloudRepoPicker`)

Owner today: `features/settings/cloud-repository-picker.tsx (CloudRepositoryPicker, RepositoryPage)`

Changes:
- Popovers and hover cards: bg3, border2, 12px corners, 12px padding.

Code notes:
- The picker popover pads 12px (menus use a 6px inset) and is 420px wide; rows are 28px with 6px corners against 30px / 8px menu rows. (`features/settings/cloud-repository-picker.tsx:93-123,236-285 · shared/ui/menu-surface.ts:16-26`)

## Settings · More · All states (`States_settings_browser`)

Composite board: implemented through the boards it imports.

## Environment · Secrets (`SetEnvironment`)

Owner today: `features/repositories/repositories-panel.tsx (UserEnvironmentPanel, EnvironmentSection) · settings/settings-ui.tsx (SettingsEmptyCard)`

Changes:
- A Keychain that can’t be read is one error row with Retry, not a sentence asking to reopen Settings.

Code notes:
- A fourth card recipe (bg1-highlight, border1, 8px) with 40px rows and 12 / 8px side padding; the value column drifts about 33px between editable and read-only rows. (`features/repositories/repositories-panel.tsx:491,508-509,547-552,852-901`)

## Settings · More · All states · Proposed (`States_settings_browser_proposed`)

Composite board: implemented through the boards it imports.

## Git & PR · Branch name prefix (`SetGitPrefix`)

Owner today: `features/settings/git-defaults-section.tsx (GitDefaultsSection, CustomPrefixInput, previewFor)`

Code notes:
- The GitHub username option carries a 25px badge, so it is taller than Custom and None; radio labels are 14px against 13px card labels. (`features/settings/git-defaults-section.tsx:169-213,353-358 · features/settings/settings-page.tsx:1360`)

## Settings · More · All states (`States_settings_appearance`)

Composite board: implemented through the boards it imports.
