# Agent chat: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Agent chat”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Chat window · New chat (`ChatWindowNewChat`)

Owner today: `shell/conversation/conversation-pane.tsx · pane-layout.tsx · chat-tabs.tsx · conversation-summary.tsx · features/agent/agent-chat.tsx · chat-provenance.tsx`

Changes:
- Composer: sidebar-bg with a border2 edge, the surface user messages and the cards above it share.
- Composer toolbar: every control is 28 (pickers, attach, gauge, Send) with 6px corners, Send the only circle, 4px gaps.
- Tool and list rows are 28 with 6px corners and a bg1-hover fill.
- Badges are 20 tall, 12/16 medium, 4px corners.
- Primary actions drop the stock shadow.
- Tabs: 28 tall, 6px corners, hover bg1-hover, active bg2 in medium.

Code notes:
- The first chat tab sits 4px from the pane edge (the pl-2 leading slot never renders) while the header icon and the workbench strip start at 8px. (`shell/conversation/chat-tabs.tsx:134-135,153-154,175 · shell/conversation/pane-layout.tsx:1312`)
- With the workbench collapsed, a 28px Summary button with a forced 16px glyph sits beside the 24px workbench toggle. (`shell/conversation/conversation-summary.tsx:172-175 · shell/workbench/toggle-button.tsx:34-36`)
- The chat tab glyph is 14px at rest but 16px while working, so the label jumps 2px at every turn start and stop; leading-none clips about 1px off descenders. (`shell/conversation/chat-tabs.tsx:186,685,895-927`)
- The header’s placement slot changes width: a 16px icon puts the name at 28px, the Cloud details button at 40px, and the Local badge pushes it further. (`shell/conversation/workspace-header.tsx:52-56,79 · shell/conversation/cloud-workspace-details.tsx:55`)
- The Created &lt;workspace&gt; badge is 26px in a block of 20px rows and never truncates, so a long branch name is cut off with no ellipsis. (`features/agent/chat-provenance.tsx:71,92-94,253-258 · shared/ui/primitives/badge.tsx:7,50`)
- The resting composer is documented as 106px but the 32px Send and gauge make it 110px, a 4px jump against the Create composer. (`features/agent/composer-editor/use-composer-editor.tsx:94-96 · shell/dispatcher/dispatcher-composer.tsx:14,630 · features/agent/agent-chat.tsx:4723`)

## Chat window · Conversation (`ChatWindowConversation`)

Owner today: `shell/conversation/pane-layout.tsx · features/agent/agent-chat.tsx · transcript-turn.tsx · turn-container.tsx · turn-footer.tsx · renderers/event-stripe.tsx`

Changes:
- User messages: sidebar-bg with a border2 edge, like the composer.
- Headers: window 40 with 12 / 6 padding, panel 36 with 12 / 4.

Code notes:
- A 24px top fade sits over a column that starts 12px down, so the first prompt’s border and first line always sit under the wash. (`features/agent/agent-chat.tsx:4268,4417`)

## Chat window · Split panes, agent working (`ChatWindowSplit`)

Owner today: `shell/conversation/pane-layout.tsx · chat-tabs.tsx · features/agent/agent-chat.tsx · turn-event-list.tsx · permission-card.tsx · renderers/event-row.tsx`

Changes:
- Cards above the composer: sidebar-bg, border2, 12px corners, no shadow, 8px apart.
- Options are 32px rows that highlight with sidebar-bg-hover; shortcuts are 18px keycaps.
- Commands, terminal output and answers sit in bg1 wells with a border1 edge.
- Cards and tiles round to 12; hover lifts to border3 + bg2-highlight.

Code notes:
- At the 360px pane minimum the toolbar has 274px, but Design mode needs about 294, so the tools slide under the actions. (`features/agent/agent-chat.tsx:4624-4639 · features/agent/composer-design-tag.tsx:13 · features/agent/composer-pills.css:5-15`)
- Chat tabs are 8px padding, 8px gap, 70–140px; workbench tabs 10 / 6px up to 180px; both 8px round where tabs spec 6; the 40px close overlay covers a 70px tab’s whole label. (`shell/conversation/chat-tabs.tsx:184,191,198-199 · shell/workbench/tab-strip.tsx:332 · shell/workbench/tab-chrome.ts:16`)
- The dock can’t shrink: a split-down pane can be 160px tall (120px under its strip), but the resting composer needs 126px, so the transcript collapses to 0 and Send is clipped. (`features/agent/agent-chat.tsx:4434,4441 · features/agent/embedded-terminal-command.tsx:159 · shell/conversation/pane-portal-store.ts:25 · shell/conversation/chat-deck.tsx:202`)

## Workspace header · Local (`ChatHeaderLocal`)

Owner today: `shell/conversation/workspace-header.tsx · conversation-summary.tsx · shell/workbench/toggle-button.tsx`

Changes:
- Icon buttons: 6px corners (4 at 20) and a bg2-highlight hover; a pressed toggle fills selected-bg with no edge.

Code notes:
- The leading slot is a 16px icon, a 24px Local badge or a 28px Cloud button, so the name starts at 28, 78 or 40px; trailing actions mix a 28px Summary with a 24px toggle. (`shell/conversation/workspace-header.tsx:52,56,79,83 · shell/conversation/cloud-workspace-details.tsx:55-56 · shell/conversation/conversation-summary.tsx:174-175`)

## Workspace header · Cloud details (`ChatHeaderCloud`)

Owner today: `shell/conversation/cloud-workspace-details.tsx · workspace-header.tsx · shell/workbench/tab-status-model.ts`

Changes:
- Popovers and hover cards: bg3, border2, 12px corners, 12px padding.

## Chat tabs · Strip (`ChatTabStrip`)

Owner today: `shell/conversation/chat-tabs.tsx · features/agent/agent-activity-indicator.tsx · chat-unread-dot.tsx · composer-draft-indicator.tsx · agent-awaiting-indicator.tsx`

Code notes:
- The 14px tab icon becomes a 16px spinner while a run is busy, so every tab title shifts 2px when a run starts or stops. (`shell/conversation/chat-tabs.tsx:897-898,913-926 · features/agent/agent-activity-indicator.tsx:19 · features/agent/chat-unread-dot.tsx:11`)
- + and ⋯ are 4px-round icon buttons with the old hover; History is a 6px ghost button; they sit flush with no gap. (`shell/conversation/new-chat-menu.tsx:66-68 · shell/conversation/chat-tabs.tsx:161-168,621-623 · shell/conversation/chat-history-menu.tsx:30,52-55 · shared/ui/primitives/icon-button.tsx:41,77`)

## Chat tabs · Hover and close (`ChatTabHover`)

Owner today: `shell/conversation/chat-tabs.tsx · features/agent/agent-awaiting-indicator.tsx`

No change beyond the shared foundation and primitives.

## Chat tabs · Menus (`ChatStripMenus`)

Owner today: `shell/conversation/chat-tabs.tsx · new-chat-menu.tsx · chat-history-menu.tsx · conversation-header.tsx (OpenInSubmenu)`

Changes:
- Menus: bg3, border2, 12px corners, 4px inset and 28px rows; labels 12 medium fg3.

## Chat tabs · Close running chat (`ChatCloseDialog`)

Owner today: `shell/conversation/chat-close-dialog.tsx · chat-close.ts`

Changes:
- Dialog: border2, 12px corners and a 16px inset; a 24px close, Ghost Cancel, and the footer rule retires.

Code notes:
- The footer pads 10px under 16px header and body, so buttons end 6px outside the text column; the body pads 24px around one line. (`shared/ui/primitives/dialog.tsx:213,226,239`)
- Three hand-built shortcut hints: a 10px keycap, a raw 16px &lt;kbd&gt; and a 10px span at 70%. (`features/agent/queued-messages-card.tsx:321-325 · features/agent/plan-review-card.tsx:135 · shell/conversation/chat-close-dialog.tsx:53`)

## Workspace summary · Island (`ChatSummary`)

Owner today: `shell/conversation/conversation-summary.tsx · summary-contents.tsx · summary-git-status.tsx · shell/pr/create-pr-button.tsx`

Code notes:
- Environment and tool rows are 32px with 8px corners, Git rows 28px with 6px; inside a 16px island with 12px padding the 8px rows break the inner-radius rule; the popover offset is 12 vs 4–6. (`shell/conversation/summary-contents.tsx:51-53,164 · shell/conversation/summary-git-status.tsx:43-45 · shell/conversation/conversation-summary.tsx:208,231-233`)

## Header and tabs · All states (`States_agent_chat_tabs`)

Composite board: implemented through the boards it imports.

## Empty chat · Workspace rows (`ChatEmptyWorkspace`)

Owner today: `features/agent/chat-provenance.tsx · shell/conversation/conversation-header.tsx (OpenInBadgeMenu)`

Code notes:
- The provenance block adds 12px padding inside the 28px gutter, so its icons sit 12px in while composer text is 14px in; transcript pills indent an off-grid 22px. (`features/agent/chat-provenance.tsx:247 · features/agent/chat-transcript-pills.tsx:127,503`)

## Empty chat · Transcript pills (`ChatEmptyTranscripts`)

Owner today: `features/agent/chat-transcript-pills.tsx · chat-provenance.tsx · chat-transcript-attach.ts`

Code notes:
- The transcript list is 30px rows with 14px icons in the popover but 42px rows with 20px icons and a 48px input in the dialog; the two attach dialogs differ in width. (`shared/ui/primitives/command.tsx:85 · features/agent/chat-transcript-pills.tsx:391-411,447 · features/agent/workspace-directory-picker.tsx:153`)
- The command search wrapper is 36px but its input is 40px, so the field overflows its row by 4px. (`shared/ui/primitives/command.tsx:106,112`)

## Empty chat · Attach chat transcript (`ChatTranscriptDialog`)

Owner today: `features/agent/chat-transcript-pills.tsx (TranscriptPickerDialog) · shared/ui/primitives/command.tsx`

No change beyond the shared foundation and primitives.

## Empty chat · Loading conversation (`ChatHistoryStates`)

Owner today: `features/agent/agent-chat.tsx · use-transcript-history-status.ts`

Code notes:
- Transcript status rows differ: loading muted with a 14px spinner, waiting fg3 with no icon, unavailable a 44px row with a 28px Retry against 34px for the rest. (`features/agent/agent-chat.tsx:4273-4300`)

## Empty chat · No folder or agent (`ChatUnbound`)

Owner today: `shell/no-folder-panel.tsx · shell/agent-removed-panel.tsx · shell/conversation/chat-view.tsx`

No change beyond the shared foundation and primitives.

## Empty chat · Read-only history (`ChatReadOnly`)

Owner today: `shell/workspace-history-bar.tsx · state/workspace-history.ts · features/agent/agent-chat.tsx (composerReplacement)`

Code notes:
- No chat history is centered in one place and top-left in another; the history error spans the full pane outside the 856px column; the read-only bar uses its own radius and insets. (`shell/conversation/conversation-pane.tsx:130 · features/agent/agent-chat.tsx:4300 · shell/conversation/chat-view.tsx:726 · shell/workspace-history-bar.tsx:125-127`)

## Empty chat · Transcript preview, menu and chip (`ChatTranscriptPreview`)

Owner today: `features/agent/chat-transcript-pills.tsx (TranscriptPill) · chat-transcript-preview.tsx · chat-transcript-attach.ts (transcriptFileName)`

Changes:
- Pills are neutral bg2 + border2: 20 inline, 24 as a control.

Code notes:
- Hover cards are 8px round on bg2 with 16px padding while menus are 16px on bg3; checkpoint rows are 32px with 6px corners; the workflow card is bg1 with a 32px header holding 28px buttons. (`shared/ui/primitives/hover-card.tsx:59 · features/agent/checkpoint-rail.tsx:560,570 · features/agent/workflow-activity.tsx:122,139-166`)

## Empty and first run · All states (`States_agent_chat_empty`)

Composite board: implemented through the boards it imports.

## Composer · Empty (`ChatComposerEmpty`)

Owner today: `features/agent/agent-chat.tsx · composer-placeholder.ts · composer-pills.tsx · composer-tools.tsx · context-gauge.tsx`

Code notes:
- Four control heights in one toolbar: permission 24, model pill 26, attach, ports and tools 28, gauge and Send 32. (`features/agent/composer-pills.tsx:56-57,504,512 · features/agent/composer-attachment-menu.tsx:63 · features/agent/boundary-ports.tsx:84 · features/agent/context-gauge.tsx:211 · features/agent/agent-chat.tsx:4723`)

## Composer · Typing (`ChatComposerTyping`)

Owner today: `features/agent/agent-chat.tsx · composer-editor/use-composer-editor.tsx · shared/ui/primitives/elements/prompt-input.tsx`

Code notes:
- Editor and bubble text are 19.25px lines but inline pills are 20px, so any line holding a pill grows taller. (`features/agent/composer-editor/use-composer-editor.tsx:104 · features/agent/renderers/text-message.tsx:185,264 · features/agent/composer-editor/pill-views.tsx:23-24`)
- Composer pills use 8px gaps and 6px padding while sent pills use 4px and 8px, though the code calls them pixel-identical. (`features/agent/composer-editor/pills.tsx:86,121-124 · features/agent/composer-editor/pill-views.tsx:7-8,26,39`)
- Toolbar radii are 4px (attach), 6px (pills), round (Send) and a 32px square tick; gaps are 2px on the left group and 6px on the right. (`features/agent/composer-attachment-menu.tsx:66 · features/agent/composer-pills.tsx:57 · shared/ui/primitives/elements/prompt-input.tsx:129 · features/agent/agent-chat.tsx:4624,4626,4657,4741`)
- The composer is 18px round with 14px padding, the edit composer and bubble 12px with 12px, though tokens say the prompt keeps one shape from typed to sent. (`features/agent/agent-chat.tsx:4534-4535 · features/agent/turn-container.tsx:247-248,285-286 · styles/zeros-tokens.css:232-236`)

## Composer · Sending (`ChatComposerSending`)

Owner today: `features/agent/agent-chat.tsx (sendPreparing) · shared/ui/primitives/elements/prompt-input.tsx`

No change beyond the shared foundation and primitives.

## Composer · Agent running (`ChatComposerStop`)

Owner today: `features/agent/agent-chat.tsx (composerStreaming) · session-reload-lifecycle.ts · turn-event-list.tsx`

No change beyond the shared foundation and primitives.

## Composer · Context pills (`ChatComposerContext`)

Owner today: `features/agent/added-directories.tsx · composer-editor/pills.tsx · composer-editor/pill-views.tsx · composer-editor/file-type-icon.tsx`

Changes:
- A pill the caret selects fills with selected-bg and keeps its border2 edge; the 2px highlighted-bright ring is gone. A workspace link steps up to blue-pill-hover.
- A hovered pill fills bg2-highlight on border3 as one shape (`PILL_HOVER`), in the composer, on sent attachments and on chat links; before, only the label's inner button filled, inside the pill.

Code notes:
- Four chip geometries in the card: 20px inline pills, 28px /add-dir chips, a 28px Design frame chip with a camera button, and a 28px Design tag. (`features/agent/composer-editor/pill-views.tsx:23-25 · features/agent/added-directories.tsx:50-63 · features/agent/composer-design-frame.tsx:176-184`)

## Composer · Drop files (`ChatComposerDrop`)

Owner today: `features/agent/agent-chat.tsx (dragActive) · composer-editor/use-composer-editor.tsx`

Code notes:
- A missing space in the edit composer’s class string (relative${…}) drops relative and the ring colour while a file is dragged over it. (`features/agent/turn-container.tsx:656-658`)

## Composer · Editing queued message (`ChatComposerQueuedEdit`)

Owner today: `features/agent/agent-chat.tsx (startQueuedEdit) · queued-messages-card.tsx`

Changes:
- Queued messages are a card of their own, no longer tucked under the composer.

Code notes:
- The queued-edit banner is a 36px row at 60% fill with 14px text (larger than the toolbar), a padless Cancel, and text starting 26px in against the editor’s 14. (`features/agent/agent-chat.tsx:4596-4604`)

## Composer · Plan mode (`ChatComposerPlan`)

Owner today: `features/agent/composer-pills.tsx (PlanModeFrame, PermissionToggle) · model-catalog.ts (permissionModeShowsFrame)`

Code notes:
- The Plan / Ask dotted frame is drawn 1px inside the card’s border with radius 17, so the dots sit about 2px in and the edge steps inward when the mode toggles. (`features/agent/composer-pills.tsx:557-558,566-567`)

## Composer · Design mode (`ChatComposerDesign`)

Owner today: `features/agent/composer-design-tag.tsx · composer-design-frame.tsx · composer-attachment-menu.tsx`

No change beyond the shared foundation and primitives.

## Composer · Mention picker (`ChatMentionPicker`)

Owner today: `features/agent/mention-picker.tsx · pr-picker.tsx · mentions.ts · composer-editor/suggestion-popup.tsx · file-type-icon.tsx`

Changes:
- Slash and @ pickers: a 4px inset, a 12px fg3 header and 24px tabs.

Code notes:
- The # PR picker is a different surface (8px corners, bg1, border1, stock shadow) from the @ and / pickers (16px, bg3, border2). (`features/agent/pr-picker.tsx:86-92 · features/agent/composer-editor/suggestion-popup.tsx:54-66`)
- Picker rows are full-bleed 30px with no 6px inset, so the 16px corners cut them; lists cap at 220px (7⅓ rows). (`features/agent/mention-picker.tsx:75,90 · features/agent/slash-command-picker.tsx:126,149 · features/agent/pr-picker.tsx:118,132`)

## Composer · Slash commands (`ChatSlashPicker`)

Owner today: `features/agent/slash-command-picker.tsx · slash-command-filter.ts · packages/protocol/src/builtin-commands.ts`

Code notes:
- Tab buttons use an invented 14px radius in a 36px bar; the skill chip is about 16px tall with 10px text. (`features/agent/slash-command-picker.tsx:88,104,180`)

## Composer · Attachment menu (`ChatAttachMenu`)

Owner today: `features/agent/composer-attachment-menu.tsx · agent-chat.tsx (enterDesignMode) · composer-design-tag.tsx`

No change beyond the shared foundation and primitives.

## Composer · Model menu (`ChatModelMenu`)

Owner today: `features/agent/agent-model-menu.tsx (AgentModelMenu, ModelConfigurationEditor, SearchModelRow) · composer-pills.tsx (ModelPill)`

Changes:
- Switch thumb sits 2px inside the track with one soft shadow.

Code notes:
- Left insets drift between 12 and 14px, so text jogs 2px between search and browse. (`features/agent/agent-model-menu.tsx:498,531,611,1155 · shared/ui/primitives/command.tsx:106`)
- Model rows are 26px with a 1px gap (28px unavailable rows and headings), 18px favourite and Edit buttons, a fixed 230px popover. (`features/agent/agent-model-menu.tsx:110-115,613,647,854,922,1156,1239`)

## Composer · Model catalog (`ChatModelCatalog`)

Owner today: `features/agent/agent-model-menu.tsx (CatalogModelRow, ModelRowActions, ModelConfigurationPopover, FavoriteModelButton)`

No change beyond the shared foundation and primitives.

## Composer · Permission mode (`ChatPermissionToggle`)

Owner today: `features/agent/composer-pills.tsx (PermissionToggle, PERMISSION_MODE_ICONS) · model-catalog.ts (permissionMenuItems)`

Code notes:
- The mode-change label is placed absolutely to the toggle’s right with no background and paints over the preview-ports pill that follows. (`features/agent/composer-pills.tsx:414-421,520-529 · features/agent/permission-feedback-placement.ts:31`)

## Composer · Context gauge (`ChatContextGauge`)

Owner today: `features/agent/context-gauge.tsx · context-usage.ts (contextGaugeData) · agent-chat.tsx (onCompactNow)`

Code notes:
- Composer popovers pad 14, 12 or 16px; context rows are 12.5px text; MCP rows start 18px in and Compact now 8px in, three left edges. (`features/agent/context-gauge.tsx:74-87,219,242,262 · features/agent/composer-tools.tsx:223 · shared/ui/primitives/popover.tsx:102`)

## Composer · Tools (`ChatToolsPopover`)

Owner today: `features/agent/composer-tools.tsx · composer-tool-groups.tsx · native-browser-availability.tsx`

Code notes:
- Group headers are 28px with the label at 28px, while their tool rows are 32px at 14px with names at 8px; status icons are 16 vs a 14px spinner; a 320px scroller nests inside the popover’s own. (`features/agent/composer-tool-groups.tsx:72,97-112,199-203,268,280,292`)

## Composer · Preview ports (`ChatPreviewPorts`)

Owner today: `features/agent/boundary-ports.tsx (BoundaryPortsPill) · agent-chat.tsx (openBoundaryPreview)`

No change beyond the shared foundation and primitives.

## Composer · All states (`States_agent_chat_composer`)

Composite board: implemented through the boards it imports.

## Composer · All states · Proposed (`States_agent_chat_composer_proposed`)

Composite board: implemented through the boards it imports.

## Messages · User prompt (`ChatUserPrompt`)

Owner today: `features/agent/turn-container.tsx (TurnPromptHeader, UserMessageActions) · renderers/text-message.tsx · composer-editor/pill-views.tsx`

Code notes:
- Older attachments are 26px chips while newer ones are 20px pills. (`features/agent/renderers/text-message.tsx:292-296,316,360`)
- Prompt hover actions are raw 16px buttons in a 22px absolute row under the bubble that hangs 6px into the next block. (`features/agent/turn-container.tsx:100,370-374,405`)
- Message content is overflow-hidden with no padding, so focus outlines on path chips and pills at a line start are clipped. (`shared/ui/primitives/elements/message.tsx:48 · styles/global/runtime-content.css:342-345 · features/agent/local-links/pill.tsx:75`)

## Messages · Git action prompt (`ChatUserAuto`)

Owner today: `features/agent/turn-container.tsx · auto-action.tsx · shell/pr/pr-action-prompts.ts · shell/pr/pr-instructions.ts`

No change beyond the shared foundation and primitives.

## Messages · Editing a prompt (`ChatUserEdit`)

Owner today: `features/agent/turn-container.tsx (TurnPromptEditor) · transcript-turn.tsx · agent-chat.tsx (editToolbarPills)`

No change beyond the shared foundation and primitives.

## Messages · Assistant answer (`ChatAnswer`)

Owner today: `features/agent/renderers/text-message.tsx · markdown-code-block.tsx · styles/global/runtime-content.css (.zeros-agent-md)`

Code notes:
- Three code styles: markdown 12 / 1.6 with 16 × 12 padding and 8px corners, tool output 14px mono at 22.75px lines in a 6px box, Read 14 / 1.6. (`features/agent/renderers/markdown-code-block.tsx:33,43 · styles/global/runtime-content.css:365-402 · features/agent/renderers/tool-detail-surface.tsx:22 · features/agent/renderers/highlighted-code.tsx:37,193-213`)

## Messages · Thinking (`ChatThinking`)

Owner today: `features/agent/renderers/event-meta.ts (Thinking) · event-row.tsx · event-row-renderer.tsx (renderDetail)`

Code notes:
- The thinking body is inset 12px at 21px lines under a label that starts at 20px, aligning with neither the icon nor the label. (`features/agent/renderers/event-row-renderer.tsx:382 · features/agent/renderers/event-row.tsx:205-207,273`)

## Messages · Local chat links (`ChatLocalLinks`)

Owner today: `features/agent/local-links/pill.tsx · local-links/note-row.tsx · turn-container.tsx (localFrom)`

No change beyond the shared foundation and primitives.

## Messages · All states (`States_agent_chat_messages`)

Composite board: implemented through the boards it imports.

## Tool calls · Group collapsed (`ChatToolGroupCollapsed`)

Owner today: `features/agent/renderers/event-stripe.tsx (EventStripe, StripeIcons) · transcript-turn.tsx`

Code notes:
- The group header pulls 4px into the gutter while rows pull 8px, and the expanded list sits 4px under its header while rows are 8px apart. (`features/agent/renderers/event-stripe.tsx:154,191 · features/agent/renderers/event-row.tsx:86,182 · shared/ui/primitives/list-row.tsx:19`)
- The checkpoint rail spans x 4–32px over a 28px gutter where tool rows begin at 20px, so below ~862px it covers 4px of text and 12px of row hover. (`features/agent/checkpoint-rail.tsx:121,526,535 · features/agent/agent-chat.tsx:4268 · features/agent/renderers/event-row.tsx:182`)

## Tool calls · Group expanded (`ChatToolGroupExpanded`)

Owner today: `features/agent/renderers/event-stripe.tsx · event-row.tsx · event-meta.ts · styles/global/runtime-content.css (.zeros-working-feed)`

Changes:
- Every tool description (a command, a thinking summary, a search) is one 20px chip, 12/16 on bg2 with 2px by 6px padding: the height of the file tags beside it, inside the 28px row.

## Tool calls · Bash (`ChatToolBash`)

Owner today: `features/agent/renderers/event-meta.ts (execute) · event-row.tsx · event-row-renderer.tsx (ToolDetail, OUTPUT_CLASS)`

Changes:
- Expanded tool calls open into a bg1 card with a border1 edge; the row keeps its look and failures stay red.
- The command preview is the 20px description chip (it was 18px).

Code notes:
- Command previews are 22px chips on bg1-hover while file rows use a 20px tag with border3 and a 13px icon. (`features/agent/renderers/event-row.tsx:170-174,251 · features/agent/renderers/file-tag.tsx:41,45`)

## Tool calls · Read (`ChatToolRead`)

Owner today: `features/agent/renderers/event-meta.ts (read) · highlighted-code.tsx (CodeWithGutter) · image-hover-card.tsx`

Code notes:
- title= attributes give native OS tooltips next to the shared Tooltip. (`features/agent/goal-card.tsx:98-174 · features/agent/composer-tool-groups.tsx:103,146,203 · features/agent/renderers/event-row.tsx:151,167`)

## Tool calls · Edit (`ChatToolEdit`)

Owner today: `features/agent/renderers/tool-edit.tsx (EditCard, EditDiff) · diff-hover-preview.tsx`

No change beyond the shared foundation and primitives.

## Tool calls · Failed (`ChatToolError`)

Owner today: `features/agent/renderers/event-row.tsx (fail tone) · event-row-renderer.tsx (SafetyReviewDetail) · tool-detail-surface.tsx`

No change beyond the shared foundation and primitives.

## Tool calls · Agent (`ChatToolAgent`)

Owner today: `features/agent/renderers/tool-subagent.tsx (SubagentRow) · event-stripe.tsx · subagent.ts`

Code notes:
- Nested bodies indent 23px with an 8px top gap (subagent) and 21px with 4px (browser, plus a 680px cap). (`features/agent/renderers/tool-subagent.tsx:160 · features/agent/renderers/browser-activity-card.tsx:124`)
- Feed labels start at 20 (tool rows), 22 (subagent), 24 (browser, reconnecting), 28 (working) or 0px (notices). (`features/agent/renderers/event-row.tsx:205-207 · features/agent/renderers/tool-subagent.tsx:110 · features/agent/renderers/browser-activity-card.tsx:94 · shared/ui/loading/activity-shimmer.tsx:84,91`)

## Tool calls · Tasks (`ChatToolTasks`)

Owner today: `features/agent/renderers/task-tool-record.tsx · background-task-record.tsx · shared/ui/primitives/card.tsx`

Code notes:
- Task records render an 8px Card with a shadow inside the 6px bordered detail surface: a double border and a clipped shadow. (`features/agent/renderers/task-tool-record.tsx:79-80 · features/agent/renderers/background-task-record.tsx:61-62`)

## Tool calls · Compaction (`ChatToolCompaction`)

Owner today: `features/agent/renderers/compaction-card.tsx (CompactionRecordCard, DoneChip)`

Code notes:
- Status chips are 6px round on Done and 4px elsewhere, with 10px text and no line-height token, so their height follows the parent. (`features/agent/renderers/compaction-card.tsx:42 · features/agent/renderers/budget-stop-card.tsx:43,47,65 · features/agent/renderers/question-card.tsx:58`)
- These renderers nest their own cards (and a 200px scroller) inside the 320px detail surface, against its one-scroll-owner rule. (`features/agent/renderers/budget-stop-card.tsx:54 · features/agent/renderers/compaction-card.tsx:106,111 · features/agent/renderers/question-card.tsx:115 · features/agent/renderers/unknown-message.tsx:34-35`)

## Tool calls · Budget stop (`ChatToolBudget`)

Owner today: `features/agent/renderers/budget-stop-card.tsx (BudgetStopRecordCard)`

Code notes:
- Continue is a raw 22px button over an 11.5px helper line. (`features/agent/turn-footer.tsx:845-853`)

## Tool calls · User input (`ChatToolQuestion`)

Owner today: `features/agent/renderers/question-card.tsx (QuestionRecordCard, StatusChip)`

No change beyond the shared foundation and primitives.

## Tool calls · Plan (`ChatToolPlan`)

Owner today: `features/agent/renderers/tool-exit-plan-mode.tsx · plan-body.ts · event-row.tsx (ToolDetailSurface)`

Code notes:
- The plan body has no padding, so plan text sits flush against the 1px border of the detail surface. (`features/agent/renderers/tool-exit-plan-mode.tsx:96-103 · features/agent/renderers/event-row.tsx:272-283 · features/agent/renderers/tool-detail-surface.tsx:22`)

## Tool calls · Browser activity (`ChatToolBrowser`)

Owner today: `features/agent/renderers/browser-activity-card.tsx · event-row-renderer.tsx (NativeBrowserToolRow) · features/browser/browser-tool-activity.ts`

No change beyond the shared foundation and primitives.

## Tool calls · Feed notices (`ChatToolNotices`)

Owner today: `features/agent/renderers/event-row-renderer.tsx (error_notice) · event-meta.ts · engine/agents/adapters/claude/translator.ts`

No change beyond the shared foundation and primitives.

## Tool calls · Image result and truncation (`ChatToolOutputs`)

Owner today: `features/agent/renderers/event-row-renderer.tsx (tool output images) · event-row.tsx (transportTruncated) · event-meta.ts (MCP rows)`

No change beyond the shared foundation and primitives.

## Tool calls · All states (`States_agent_chat_tools`)

Composite board: implemented through the boards it imports.

## Cards · Permission, run command (`ChatPermissionCommand`)

Owner today: `features/agent/permission-card.tsx · agent-chat.tsx (pending permission dock)`

Code notes:
- The queued card tucks −10px under the composer, so when a permission, question or plan card sits between them it paints over that card’s top 8px. (`features/agent/queued-messages-card.tsx:122-127 · features/agent/permission-card.tsx:365 · features/agent/question-card.tsx:391 · features/agent/plan-review-card.tsx:88`)
- The dock gap is 2px, so independent 8px cards sit 2px from each other and from the composer. (`features/agent/agent-chat.tsx:4441`)
- Three answer-row geometries: 38px bordered permission rows 6px apart, 32px borderless options 2px apart, and right-aligned 28px buttons for approval. (`features/agent/permission-card.tsx:387,399,520 · features/agent/question-card.tsx:427,437,746-786`)
- Dock cards use six insets and two fills (12 × 8 to 14 × 12, bg1 or bg2), with 16px icons in 28px buttons. (`features/agent/goal-card.tsx:67,100-176 · features/agent/plan-review-card.tsx:88,91 · features/agent/permission-card.tsx:365 · features/agent/embedded-terminal-command.tsx:117-193`)

## Cards · Permission, apply change (`ChatPermissionEdit`)

Owner today: `features/agent/permission-card.tsx (describePermission, PermRow) · engine/agents/adapters/claude-sdk/adapter.ts`

No change beyond the shared foundation and primitives.

## Cards · Permission, browser action (`ChatPermissionBrowser`)

Owner today: `features/agent/permission-card.tsx (contextItems, useOptionNames) · agent-control/agent-control-confirmation-store.ts · packages/protocol/src/agent-control.ts`

No change beyond the shared foundation and primitives.

## Cards · Question, single choice (`ChatQuestionSingle`)

Owner today: `features/agent/question-card.tsx (QuestionCard)`

Code notes:
- Dismiss is a raw 20px button pulled out with negative margins; chevrons are 16px targets, dots 6px; Submit is a 28px square against the 32px round Send. (`features/agent/question-card.tsx:415-423,524-563,595-605`)

## Cards · Question, several answers (`ChatQuestionMulti`)

Owner today: `features/agent/question-card.tsx (QuestionCard, carousel, countdown)`

No change beyond the shared foundation and primitives.

## Cards · Question, one-click approval (`ChatQuestionApproval`)

Owner today: `features/agent/question-card.tsx (ApprovalCard)`

No change beyond the shared foundation and primitives.

## Cards · Plan review (`ChatPlanReview`)

Owner today: `features/agent/plan-review-card.tsx · composer-pills.tsx (PlanModeFrame)`

No change beyond the shared foundation and primitives.

## Cards · Queued messages (`ChatQueued`)

Owner today: `features/agent/queued-messages-card.tsx · agent-chat.tsx (queue, startQueuedEdit)`

No change beyond the shared foundation and primitives.

## Cards · Goal (`ChatGoal`)

Owner today: `features/agent/goal-card.tsx (GoalCard, statusLabel)`

Changes:
- Fields: 13/18 text, 8px padding, no shadow; clicking in and typing change nothing.

## Cards · Terminal command (`ChatTerminalCommand`)

Owner today: `features/agent/embedded-terminal-command.tsx · packages/protocol/src/builtin-commands.ts (CLAUDE_TERMINAL_COMMANDS)`

No change beyond the shared foundation and primitives.

## Cards above the composer · All states (`States_agent_chat_cards`)

Composite board: implemented through the boards it imports.

## Turn footer · Finished turn (`ChatFooter`)

Owner today: `features/agent/turn-footer.tsx · turn-usage-card.tsx (TurnUsageCard)`

Code notes:
- Footer buttons are 20px with a 14px Copy beside a 16px ⋯; the usage trigger is a raw text button; the status chip is a 24px bordered pill on its own row. (`features/agent/turn-footer.tsx:727-731,748-750,763,819 · features/agent/turn-usage-card.tsx:96`)

## Turn footer · Files changed (`ChatFooterChanges`)

Owner today: `features/agent/turn-footer.tsx (TurnChangesCard, TurnFileRow) · renderers/diff-hover-preview.tsx`

No change beyond the shared foundation and primitives.

## Turn footer · Stopped (`ChatFooterStatus`)

Owner today: `features/agent/turn-footer.tsx (turnFooterStatusLabel, continueReason)`

No change beyond the shared foundation and primitives.

## Turn footer · Reset changes (`ChatResetDialog`)

Owner today: `features/agent/turn-footer.tsx (confirmOpen, runReset)`

No change beyond the shared foundation and primitives.

## Activity · Agent working (`ChatActivity`)

Owner today: `shared/ui/loading/activity-shimmer.tsx · gibberish-thinking.ts · features/agent/background-task-activity.tsx`

No change beyond the shared foundation and primitives.

## Activity · Workflow (`ChatWorkflow`)

Owner today: `features/agent/workflow-activity.tsx (WorkflowActivity, WorkflowProgressPanel)`

No change beyond the shared foundation and primitives.

## Turn footer and activity · All states (`States_agent_chat_footer`)

Composite board: implemented through the boards it imports.

## Notices · Turn failed (`ChatTurnFailure`)

Owner today: `features/agent/turn-failure-card.tsx · agent-notice.tsx · turn-footer.tsx`

Code notes:
- Notice actions are 28px ghosts offset sideways but not vertically, so the notice reads 8px above and about 13px below. (`features/agent/agent-notice.tsx:13-14,59 · features/agent/turn-failure-card.tsx:55,58 · features/agent/authentication-notice.tsx:38`)

## Notices · Sign-in required (`ChatSignIn`)

Owner today: `features/agent/authentication-notice.tsx · agent-notice.tsx`

Code notes:
- Sign-in icons are 16px in a 28px button and 12px in the subscription button; the signed-in state is a 28px 14px badge. (`features/agent/authentication-notice.tsx:23,40 · features/agent/subscription-signin-button.tsx:28,38`)

## Notices · Stop not confirmed (`ChatStopNotice`)

Owner today: `features/agent/agent-chat.tsx (cloudStop, preparationFailure) · sessions-provider.tsx · agent-notice.tsx`

No change beyond the shared foundation and primitives.

## Notices · Model fallback (`ChatModelFallback`)

Owner today: `features/agent/model-fallback.ts (fallbackDisplayText) · renderers/model-switch-card.tsx · packages/protocol/src/agent-messages.ts (modelFallbackText)`

No change beyond the shared foundation and primitives.

## Pills · Jump to prompt and latest (`ChatJumpPills`)

Owner today: `features/agent/jump-pills.tsx (JumpToPromptPill, JumpToLatestPill) · agent-chat.tsx`

Code notes:
- Jump to your prompt is absolute inside the scroller, so it scrolls off-screen exactly when it should show; it is 27px tall and pinned to the scroller, not the column. (`features/agent/jump-pills.tsx:76 · features/agent/agent-chat.tsx:4257-4261,4409`)

## Pills · Checkpoint rail (`ChatCheckpointRail`)

Owner today: `features/agent/checkpoint-rail.tsx (CheckpointRail, summarizeCheckpointText)`

No change beyond the shared foundation and primitives.

## Pills · Tooltips (`ChatTooltips`)

Owner today: `features/agent/jump-pills.tsx · composer-pills.tsx · composer-tools.tsx · context-gauge.tsx · turn-container.tsx · turn-footer.tsx · plan-review-card.tsx · question-card.tsx`

Changes:
- Tooltips are solid bg3 with border2 and 6px corners; the translucent glass retires.

## Notices · Pills and indicators · All states (`States_agent_chat_notices`)

Composite board: implemented through the boards it imports.
