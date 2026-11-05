# Customize: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Customize”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Customize · MCP servers (`CustPage`)

Owner today: `features/agent-extensions/customize-page.tsx · customize-mcp.tsx`

Changes:
- Customize uses the Settings shell: one centered 640px column, one title with the scope select.
- MCP servers and Skills are a segmented control; the repeated MCP servers title retires.
- Servers are rows: transport, name, endpoint, then the switch and one ⋯ menu for Edit and Remove. Status shows only when a server needs you.
- Add server is the last row of the card.

Code notes:
- Customize has no .settings-type-scale, so the shared kit renders 14px here while Settings renders 13px. (`features/agent-extensions/customize-page.tsx:258 · features/settings/settings-page.css:5-7`)
- Category tabs: a 32px list with 4px padding holds 26px pills, so they overflow by 1px. (`features/agent-extensions/customize-page.tsx:302-307 · shared/ui/primitives/tabs.tsx:27,52`)
- Two title stacks: h1 + 14px subtitle, 20px, the scope row, 32px, then a second 14px title + 13px description. (`features/agent-extensions/customize-page.tsx:275-319 · features/agent-extensions/customize-mcp.tsx:820-823`)
- The scope trigger is 32px with 4px corners, 12px padding, 14px text, a 16px chevron and a shadow; menu rows mix 14px names and 13px sublines. (`features/agent-extensions/customize-page.tsx:68-153 · shared/ui/primitives/select.tsx:96-97 · shared/ui/primitives/dropdown-menu.tsx:254,349`)
- Four page frames: Customize is left-aligned up to 1024px with 24–100px fluid padding, Org MCP centered at 896px, the Skill form 672px and the MCP editor full width. (`features/agent-extensions/customize-page.tsx:258 · features/agent-extensions/mcp-organization-page.tsx:73 · features/agent-extensions/customize-extensions.tsx:80 · features/agent-extensions/mcp-server-editor.tsx:265`)

## Customize · Scope picker (`CustScopeMenu`)

Owner today: `features/agent-extensions/customize-page.tsx · ScopePicker`

Changes:
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.

## Customize · Organization MCP (`CustOrgPage`)

Owner today: `features/agent-extensions/mcp-organization-page.tsx · OrganizationMcpPage`

Changes:
- The org page uses the Settings shell: one column, one title, Add server in the header.
- Loading is one quiet row; a failed load is one error row with Retry.
- Servers are rows: transport, name, endpoint, then the switch and one ⋯ menu for Edit and Remove.

Code notes:
- The h1 sits on a 28px line; a 12px fg2 heading sits over a larger 13px description; Repository connection fakes tabs with buttons. (`features/agent-extensions/mcp-organization-page.tsx:30-39,78-95`)
- Loading is an empty 96px box, a 13px line, 14px text or a spinner; errors are 13px red in Settings and 14px in MCP and Skills. (`features/settings/providers-panel.tsx:398 · features/agent-extensions/customize-mcp.tsx:854-861 · features/agent-extensions/mcp-organization-page.tsx:82 · features/agent-extensions/customize-extensions.tsx:293,307-311`)

## MCP servers · Section and new server (`CustMcpSection`)

Owner today: `features/agent-extensions/customize-mcp.tsx · CustomizeMcpSection, NewServerCard`

Changes:
- The section is the Customize card: one line, Import, then rows; Add server is the last row.
- Errors and the tool cap are one row in the card; loading holds two skeleton rows.

Code notes:
- The New server card (8px corners, 16px padding) sits 12px under the list card (12px corners, 12px padding), so edges and insets do not line up. (`features/agent-extensions/customize-mcp.tsx:505-516,863-900`)
- Five empty-state recipes, from an unboxed 14px line to a 144px bordered card and a 96px dashed button. (`features/settings/settings-ui.tsx:253,269 · features/repositories/files-to-copy-section.tsx:385,402 · features/agent-extensions/customize-mcp.tsx:505 · features/agent-extensions/customize-extensions.tsx:388,398`)
- Two header systems: SettingsGroup (12px fg2 + 12px muted, 8px above) and SettingsSection (14px fg1 + 13px fg2, 12px above). (`features/settings/settings-ui.tsx:49-56,106-116`)

## MCP server · Connected (`CustMcpConnected`)

Owner today: `features/agent-extensions/customize-mcp.tsx · ServerRow · mcp-connection-view.ts`

Changes:
- The same row and card as the server list.
- Connected is the normal state, so it shows nothing; a gateway server shows its tool count, which opens the list.

Code notes:
- Trailing controls shift: signing in swaps a 14px icon for a 16px spinner and adds Cancel (about 60px); the switch carries an extra 4px margin. (`features/agent-extensions/customize-mcp.tsx:323-399`)
- The transport chip is content-width (36–47px), so names in one card do not share a left edge; the 36px tools indent matches none of them. (`features/agent-extensions/customize-mcp.tsx:303-311,422 · features/agent-extensions/mcp-server-model.ts:89-91`)
- Six chip builds, from 10px text with 4px padding to 24px semibold badges. (`features/settings/settings-ui.tsx:317 · features/settings/providers-panel.tsx:459 · features/agent-extensions/customize-mcp.tsx:306,471 · shared/ui/primitives/badge.tsx:7 · features/settings/github-section.tsx:172`)
- Five destructive patterns: a ghost Delete, a hand-tinted secondary, an instant red-hover trash, an inline text confirm and a dialog with two Secondary buttons. (`features/settings/settings-page.tsx:956,1300-1312 · features/repositories/repositories-panel.tsx:624 · features/agent-extensions/customize-mcp.tsx:414,764 · features/settings/cloud-credential-removal-dialog.tsx:20-21`)

## MCP server · Tools shown (`CustMcpTools`)

Owner today: `features/agent-extensions/customize-mcp.tsx · ServerRow tools`

Changes:
- The tool count opens the list; Connected needs no chip.
- Tools sit under the server name in 13px sans, off tools in fg3; their switches line up with the server’s.
- No nested box: one inset rule separates the tools from the server.

Code notes:
- Two tools lists: 24px rows in a 6px box inline, 44px rows in a card in the editor. (`features/agent-extensions/customize-mcp.tsx:421-439 · features/agent-extensions/mcp-tools-section.tsx:56-68`)

## MCP server · Sign-in required (`CustMcpSignIn`)

Owner today: `features/agent-extensions/customize-mcp.tsx · ServerRow`

Changes:
- The same row and card as the server list.
- One action, Connect; No browser? moves into the ⋯ menu.

Code notes:
- Sign-in required is fg2 in lists but yellow in the editor. (`features/agent-extensions/customize-mcp.tsx:291-294 · features/agent-extensions/mcp-server-editor.tsx:264`)
- Three Connect builds: with a LogIn icon, without one, and a ghost No browser? as a third control. (`features/agent-extensions/customize-mcp.tsx:354-392`)

## MCP server · Signing in (`CustMcpSigningIn`)

Owner today: `features/agent-extensions/customize-mcp.tsx · ServerRow (signingIn)`

Changes:
- The same row and card as the server list.
- While signing in the row says so and offers only Cancel.

## MCP server · Connection failed (`CustMcpFailed`)

Owner today: `features/agent-extensions/customize-mcp.tsx · ServerRow · mcp-connection-view.ts`

Changes:
- The same row and card as the server list.

## MCP server · Starts with agent (`CustMcpStdio`)

Owner today: `features/agent-extensions/customize-mcp.tsx · ServerRow`

Changes:
- The same row and card as the server list.
- Starting with the agent is the normal state for a command server, so it shows nothing.

## MCP server · Disabled (`CustMcpDisabled`)

Owner today: `features/agent-extensions/customize-mcp.tsx · ServerRow · mcp-connection-view.ts`

Changes:
- The same row and card as the server list.
- The switch already says Disabled, so the chip retires.

Code notes:
- Disabled rows look enabled: only a 13px Disabled label and an off switch mark them. (`features/agent-extensions/customize-mcp.tsx:296-322,463`)

## MCP server · Needs connection (`CustMcpNeedsConnection`)

Owner today: `features/agent-extensions/customize-mcp.tsx · ServerRow · mcp-connection-view.ts`

Changes:
- The same row and card as the server list.
- Connect looks the same for every server; a sign-in server opens the browser, others open the editor.

## MCP server · Inherited (`CustMcpInherited`)

Owner today: `features/agent-extensions/customize-mcp.tsx · InheritedServerRow`

Changes:
- The Inherited group of the server list: a dimmed name, the source badge and Override here.

Code notes:
- Inherited names are 14px regular (own rows 13px medium), the whole row is at 80% so Override here dims too, and the layer badge is 10px. (`features/agent-extensions/customize-mcp.tsx:463-486,905-911`)

## Customize page · MCP server list · All states (`States_customize_page`)

Composite board: implemented through the boards it imports.

## Add MCP server · Command (STDIO) (`CustEditorCommand`)

Owner today: `features/agent-extensions/mcp-server-editor.tsx · mcp-server-form.tsx`

Changes:
- Field hints only where they add something; the ones that repeat the label or the value retire.
- Add argument and Add variable sit centred under their rows.
- The editor sits in the server list’s 640 column.

Code notes:
- SelectRow wraps, so an 85-character OAuth hint pushes the select onto its own left-aligned line. (`features/agent-extensions/mcp-server-editor.tsx:62-64,333-337 · features/settings/settings-ui.tsx:182-203`)
- Disclosures are 24 or 28px with 12 or 14px chevrons and no x-padding, so the hover hugs the text; Add buttons are fit-width secondaries. (`features/agent-extensions/mcp-server-editor.tsx:66-89,312-315,331,348-352`)
- Inputs and textareas pad 12px with shadow-sm while selects and buttons pad 6px, so stacked field text starts 6px apart. (`shared/ui/primitives/input.tsx:17 · shared/ui/primitives/textarea.tsx:15 · shared/ui/primitives/select.tsx:97 · shell/dialogs/feedback-dialog.tsx:106,121`)
- Two form headers: a 24px breadcrumb with an 18px h1 on a 28px line (MCP), and a 28px ← Skills with a 16px h2 and bottom actions. (`features/agent-extensions/mcp-server-editor.tsx:266-275 · features/agent-extensions/customize-extensions.tsx:86-92,138-150`)

## Edit MCP server · Remote with sign-in (`CustEditorRemote`)

Owner today: `features/agent-extensions/mcp-server-editor.tsx · mcp-tools-section.tsx`

Changes:
- Status uses the server list’s badges and compact action: Sign-in required, Signing in…, Connected, Connection failed.
- Tools are the list’s sans rows; the count and “apply when you save” share one line.
- Add variable sits centred in its card.
- The editor sits in the server list’s 640 column.

Code notes:
- Trailing selects come in three widths (128px, min 160px, fit), so stacked triggers have ragged edges; Select width="fixed" has no callers. (`features/settings/follow-up-behavior-setting.tsx:18 · shared/ui/primitives/select.tsx:86-89 · features/settings/settings-page.tsx:1168,1518,1541`)

## Add MCP server · Import a configuration (`CustEditorImport`)

Owner today: `features/agent-extensions/mcp-server-editor.tsx · mcp-configuration-import.ts`

Changes:
- The editor sits in the server list’s 640 column.
- The Import title under Import a configuration retires.

Code notes:
- Choose file and Parse sit at opposite edges, and the JSON / TOML textarea is 13px sans. (`features/agent-extensions/mcp-server-editor.tsx:351-366`)

## Import MCP servers · Dialog (`CustImportDialog`)

Owner today: `features/agent-extensions/mcp-import-dialog.tsx · engine/agents/mcp-scan.ts`

Changes:
- One line says what Import does; a failed scan is one error row with Retry.
- Rows use the server list’s anatomy: checkbox, transport, name and endpoint; Imported and Name in use are badges.
- A selected server whose name is taken gets an Import name field under its row; Import stays off until every name is free.

Code notes:
- A nested scroller inside the dialog body; rows inset 6px past the header edge, a custom 16px checkbox, and Retry right after the error text. (`features/agent-extensions/mcp-import-dialog.tsx:350-418 · shared/ui/primitives/checkbox.tsx:69`)
- Dialog widths are 384, 448 and 512px; the main action is destructive, primary or Secondary when the variant is left out. (`shared/ui/primitives/dialog.tsx:169 · features/settings/cloud-credential-removal-dialog.tsx:14,20-21 · shell/dialogs/feedback-dialog.tsx:91,171`)

## MCP sign-in · Device login (`CustDeviceLogin`)

Owner today: `features/agent-extensions/customize-mcp.tsx · HeadlessAuthModal`

Changes:
- One line of instructions; the field hint that repeated it retires.

Code notes:
- Label-to-field is 6 or 8px, field gaps run 12–28px, and dialog inputs render 14px outside the type scale. (`features/agent-extensions/customize-mcp.tsx:167-216 · shell/dialogs/feedback-dialog.tsx:99-129 · features/agent-extensions/customize-extensions.tsx:94-125 · features/settings/providers-panel.tsx:915-962`)

## MCP server editor · All states (`States_customize_editor`)

Composite board: implemented through the boards it imports.

## MCP server editor · All states · Proposed (`States_customize_editor_proposed`)

Composite board: implemented through the boards it imports.

## Skills · List (`CustSkills`)

Owner today: `features/agent-extensions/customize-extensions.tsx · CustomizeExtensionsSection`

Changes:
- Skills are rows in one card like MCP servers: name, when to use it, one ⋯ menu for Edit and Remove.
- The SKILL.md path and the Available status retire; New skill is the last row.

Code notes:
- Each skill is its own bordered 6px card 16px apart, while MCP is one 12px card with divided rows; the path breaks mid-segment. (`features/agent-extensions/customize-extensions.tsx:249-343`)

## Skills · Empty (`CustSkillsEmpty`)

Owner today: `features/agent-extensions/customize-extensions.tsx · CustomizeExtensionsSection`

Changes:
- Every state is a row in the Skills card: loading, offline and read errors are one message row, empty is one quiet line.
- A cloud workspace shows one empty state instead of a bare line.

Code notes:
- A 14px sentence plus a separate 96px dashed New skill button, which stays under the cards once there are entries. (`features/agent-extensions/customize-extensions.tsx:387-401`)

## Skills · Remove confirmation (`CustSkillRemove`)

Owner today: `features/agent-extensions/customize-extensions.tsx · CustomizeExtensionsSection`

Changes:
- Remove asks inline in the row: Remove this skill?, Cancel, then a destructive Remove.

Code notes:
- An inline Remove this skill? with a secondary Remove replaces the ghost Edit and Remove. (`features/agent-extensions/customize-extensions.tsx:344-383`)

## Skills · New skill form (`CustSkillForm`)

Owner today: `features/agent-extensions/customize-extensions.tsx · SkillForm`

Changes:
- The Skill form is laid out like the MCP editor: the list’s 640 column, a breadcrumb, the title with Save skill, one card of fields.
- Cancel retires; the breadcrumb goes back. A bad name shows under its field.

Code notes:
- 672px max, 14px labels and a 14-row 14px textarea; Save skill renders Secondary beside a Secondary Cancel. (`features/agent-extensions/customize-extensions.tsx:79-150`)

## Skills · All states (`States_customize_skills`)

Composite board: implemented through the boards it imports.
