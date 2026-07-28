# Workspace Store Cleanup & Render Performance

> **Status:** ✅ **COMPLETE (2026-05-31).** All 28 `useWorkspace()` consumers across 19 files
> migrated to slice selectors (Waves 1–3 per Appendix C). The React Context + `useReducer`,
> `WorkspaceProvider`, and the `useWorkspace()` shim are **deleted**; reload-persistence moved into
> the store as a module-level `subscribe`. Verified: `tsc` clean (zero new errors vs. baseline),
> 292/292 tests pass, ESLint clean. The original `reducer` is reused verbatim inside
> `workspace-store.ts`, so behavior is unchanged. Remaining: the manual smoke test / DevTools
> Profiler confirmation of no cross-surface cascade (Definition of Done).
> **Goal:** Migrate the workspace store off **React Context + `useReducer`** to **Zustand** with
> slice selectors, and kill the render cascades that follow from a single shared Context object.
>
> **Rewritten 2026-05-31.** The original "Roadmap 04" targeted the now-removed Design tab / React
> Flow canvas (`variant-node.tsx`, `style-panel.tsx`, `src/zeros/canvas/`) — all deleted. This is
> the current-app version: it's about the workspace **store**, not the dead canvas. The old
> variant-iframe virtualization concern moved to `multitab-terminal-files-git.md` §2.5 (it now
> lives in browser **canvas mode**, not the removed React Flow canvas).

---

## Why this matters

- `src/zeros/store/store.tsx` **was** React Context + `useReducer`; every consumer shared one
  Context value, so any state change (active chat, selection, active page, project meta) woke
  unrelated consumers. **(Resolved 2026-05-31 — state now lives in `workspace-store.ts` on Zustand;
  see Status. This section is the original motivation.)**
- **28 `useWorkspace()` call sites across 19 files** *(audited 2026-05-31 — the earlier "~66 / ~23"
  estimate was high; precise per-consumer table in Appendix A)* — `app-shell.tsx` alone hosts 6
  independent consumers; plus `column1/2/3` shell, chat surfaces (`agent-chat.tsx`,
  `turn-container.tsx`, `selection-sync.tsx`), `column3-tabs/browser-tab.tsx`, `settings-page.tsx`,
  and the `store/` helper hooks (`use-active-workspace.ts`, `use-chat-cwd.ts`).
- The **sessions store already uses Zustand** with per-slice subscription
  (`src/zeros/agent/sessions-store.ts`) — the proven pattern to copy.

This is the highest-leverage render-perf cleanup left in the shell now that the canvas is gone.

---

## Pending tasks

1. ✅ **Consumer audit (done 2026-05-31).** Enumerated every `useWorkspace()` consumer — **28 call
   sites across 19 files** — with read fields + write actions, classified **hot** (subscribes to a
   frequently-changing field) vs **cold** (rarely-changing / write-only / read-on-demand). Full
   table in **Appendix A**, recommended Zustand slices in **Appendix B**, cold→hot migration order
   in **Appendix C**.
2. ✅ **Zustand store (done 2026-05-31).** `src/zeros/store/workspace-store.ts` holds the full
   `WorkspaceState` with the **original `reducer` + `Action` union + `initialState` reused
   verbatim** as the engine (`dispatch(action) => set((s) => reducer(s, action))`) — no transition
   logic rewritten, so behavior is bit-identical and the reducer's same-reference no-op returns flow
   straight into Zustand's `Object.is` skip (re-render suppression preserved). `useWorkspace()` in
   `store.tsx` is now a thin shim over the store (same `{ state, dispatch }` shape) and
   `WorkspaceProvider` is retained only as the persistence host. `useWorkspaceDispatch()` added for
   write-only consumers. Slice-shaped selectors (Appendix B) are added per wave in step 3 rather
   than hand-writing named actions — keeps consumer churn minimal and writes on the proven path.
3. ✅ **Consumer migration (done 2026-05-31).** All 19 files migrated cold→hot in three waves
   (Appendix C): Wave 1 (cold slices + the 9 subscription-free consumers), Wave 2 (the two wrapper
   hooks + simple readers), Wave 3 (hot chat surfaces — `agent-chat`, chat-view/tabs, terminal-deck,
   `column1`, the six `app-shell` consumers). Verified with `tsc` + 292 tests after each wave.
   `mentions.ts` was decoupled to take `BrowserPickerSelection` directly instead of the whole state.
4. ✅ **Context plumbing deleted (done 2026-05-31).** `WorkspaceProvider`, the `WorkspaceContext`,
   and the `useWorkspace()` shim are removed; `app-shell` no longer wraps the tree in a provider,
   and persistence is a module-level `useWorkspaceStore.subscribe`. `git grep
   'WorkspaceContext\|WorkspaceProvider'` returns only comments/docs. The `reducer` is intentionally
   **kept** as the pure engine inside `workspace-store.ts` (reused verbatim for bit-identical
   behavior) — no longer Context/`useReducer`-bound.
5. ◻️ **Render-cascade audit (pending — needs the running app).** Structural work is done: every
   consumer subscribes to a narrow slice, by-id/derived selectors avoid whole-`chats` churn, and
   `dispatch`/actions are stable references. Final confirmation — DevTools Profiler showing updates
   stay local on selection / active-chat / active-page changes — is part of the manual smoke test.

---

## Definition of Done

- Workspace state is on Zustand with slice subscriptions; no consumer subscribes to the whole store.
- The Context + `useReducer` plumbing is deleted.
- React DevTools Profiler shows **no cross-surface re-render cascade** on an active-chat or
  selection change.

---

## Out of scope

- The `.0c` → `artifacts/` migration.
- **Variant-iframe viewport virtualization** — now tracked in `multitab-terminal-files-git.md`
  §2.5 (browser canvas mode).
- Rust engine.

---

## References

- Pattern to copy: `src/zeros/agent/sessions-store.ts` (Zustand slice-subscription model).
- Current store: `src/zeros/store/store.tsx` (Context + `useReducer`) + helper hooks under
  `src/zeros/store/`.

## Appendix A — Workspace consumers *(audited 2026-05-31)*

**Scope:** 28 `useWorkspace()` call sites across 19 files (the `store.tsx` definition and doc
references excluded). Each file was read in full.

**Classification is read-driven.** A consumer's re-render cost is set by what it **reads**, not what
it writes — `dispatch` is already a stable reference and stays stable once it's a set of Zustand
actions, so writing never re-renders the writer. Read tags below:

- `(render)` — read during render → **needs a live selector subscription**.
- `(effect)` — read inside `useEffect` / its dep array → usually needs a subscription.
- `(cb)` — read only inside an event handler → **no subscription**; read via `store.getState()`.
- `(once)` — read once at mount (lazy `useState`/`useRef`) → **no subscription**; seed from `getState()`.

`Hot?` = re-render frequency. **Hot** = subscribes to a frequently-changing field. **Cold** = only
cold fields, write-only, or `(cb)`/`(once)` reads. `*` = looks hot today but becomes
subscription-free once `(cb)`/`(once)` reads move to `getState()`.

| Consumer (file · component) | Reads | Writes (actions) | Hot? |
|---|---|---|---|
| **app-shell.tsx** · PreWarmAgents | chats, activeChatId (effect/cb-dep) | — | **Hot** |
| **app-shell.tsx** · HydrateAiApiKey | aiSettings (once) | SET_AI_SETTINGS | Cold |
| **app-shell.tsx** · ChatsPersistence | chats, activeChatId (effect) | HYDRATE_CHATS, ARCHIVE_CHAT | **Hot** |
| **app-shell.tsx** · ReloadOnProjectChange | — | BUMP_PROJECT_GENERATION | Cold |
| **app-shell.tsx** · ShellRouter | activePage (render) | — | **Hot** |
| **app-shell.tsx** · MainShellBody | — | SET_ACTIVE_CHAT, SET_NEW_AGENT_FOLDER | Cold |
| **use-active-workspace.ts** (hook) | activeChatId, chats, newAgentFolder (render) | — | **Hot** |
| **use-chat-cwd.ts** (hook) | chats, activeChatId, newAgentFolder (render) | — | **Hot** |
| **auto-connect.tsx** | project (render + effect) | CONNECT_PROJECT | Cold |
| **agent-chat.tsx** | chats→1 (render), browserPickerSelection (memo), activeChatId · pendingChatSubmission · pendingComposerAppend · elements (effect), chatComposerDrafts (once) | UPDATE_CHAT_SETTINGS, SET_CHAT_DRAFT, CLEAR_CHAT_DRAFT, UPDATE_CHAT_TITLE, CONSUME_CHAT_SUBMISSION, CONSUME_COMPOSER_APPEND | **Hot** |
| **turn-container.tsx** · TurnPromptHeader | editComposerDrafts[key] (render) | SET_EDIT_DRAFT, CLEAR_EDIT_DRAFT | **Hot** |
| **selection-sync.tsx** | browserPickerSelection (effect) | — | **Hot** |
| **column2-chat-view.tsx** · Column2ChatView | chats, activeChatId (render) | UPDATE_CHAT_SETTINGS | **Hot** |
| **column2-chat-view.tsx** · AutoBindAgent | chats (once) | HYDRATE_CHATS | Cold* |
| **column2-chat-view.tsx** · ChatBody | chats→1 (render + effect) | UPDATE_CHAT_SETTINGS | **Hot** |
| **column2-workspace.tsx** | activeChatId (render) | — | **Hot** |
| **column2-topbar.tsx** | activeChatId, chats, newAgentFolder (render) | — | **Hot** |
| **column2-chat-tabs.tsx** · Column2ChatTabs | activeChatId (render + effect), chats (memo), newAgentFolder (effect) | SET_ACTIVE_CHAT, ARCHIVE_CHAT, UNARCHIVE_CHAT, TOUCH_CHAT, SET_NEW_AGENT_FOLDER | **Hot** |
| **column2-chat-tabs.tsx** · TabRow | — | UPDATE_CHAT_TITLE | Cold |
| **column2-new-chat-menu.tsx** · Column2NewChatMenu | chats (cb) | ADD_CHAT, SET_ACTIVE_CHAT | Cold* |
| **column2-new-chat-menu.tsx** · ChatMenuItem | — | ADD_CHAT, SET_ACTIVE_CHAT | Cold |
| **column2-terminal-deck.tsx** | chats (memo), activeChatId (render) | — | **Hot** |
| **empty-composer.tsx** | newAgentFolder (render + effect), emptyComposerDraft (once) | SET_NEW_AGENT_FOLDER, SET_EMPTY_DRAFT, CLEAR_EMPTY_DRAFT, ENQUEUE_CHAT_SUBMISSION, ADD_CHAT, SET_ACTIVE_CHAT, SET_ACTIVE_PAGE | **Hot** |
| **column1.tsx** | chats, activeChatId, newAgentFolder (render→props); chats (cb + effect) | SET_ACTIVE_CHAT, SET_ACTIVE_PAGE; *(via `spawn-default-chat`)* ADD_CHAT, SET_NEW_AGENT_FOLDER | **Hot** |
| **column3.tsx** | column3Tabs, activeColumn3TabId (render + effect) | — | Cold |
| **column3-tab-strip.tsx** | column3Tabs, activeColumn3TabId (render) | ADD_COLUMN3_TAB, REMOVE_COLUMN3_TAB, ACTIVATE_COLUMN3_TAB | Cold |
| **column3-tabs/browser-tab.tsx** | activeChatId (cb) | SET_BROWSER_PICKER_SELECTION, ENQUEUE_COMPOSER_APPEND, ENQUEUE_CHAT_SUBMISSION, UPDATE_COLUMN3_TAB | Cold* |
| **settings-page.tsx** | — | SET_ACTIVE_PAGE | Cold |

### Key findings

1. **Reads, not writes, drive the cascade — and 9 of 28 call sites need no live subscription at
   all.** Write-only or read-only-in-callback/at-mount: `HydrateAiApiKey`, `MainShellBody`,
   `ReloadOnProjectChange`, `AutoBindAgent`, `TabRow`, `Column2NewChatMenu`, `ChatMenuItem`,
   `browser-tab`, `settings-page`. Today every one re-renders on *any* state change, yet none needs
   to subscribe. Converting their reads to `store.getState()` removes them from the cascade at
   near-zero risk — the cheapest, highest-leverage early win.
2. **Two wrapper hooks fan out widely.** `useActiveWorkspace()` and `useChatCwd()` each read `chats`
   + `activeChatId` + `newAgentFolder` but only to compute a single derived value (a workspace
   object / a `cwd` string). Every Column-2 surface and every IDE panel that calls them re-renders
   on every chat mutation. Narrowing each to a **selector returning the derived primitive** fixes
   all their downstream consumers at once.
3. **Almost nobody needs the whole `chats` array.** `agent-chat`, `ChatBody`, `Column2ChatView`
   want a **single chat by id**; `turn-container` wants a **single `editComposerDrafts[key]`
   entry**; `column2-terminal-deck` wants the **terminal-kind subset**. By-id / by-key selectors
   (not whole-array subscriptions) are the core of the win.
4. **One-shot hand-offs are already half-decoupled.** `pendingChatSubmission` /
   `pendingComposerAppend` (enqueue→consume, id-guarded) and the composer drafts are read in
   effects / at mount — they map cleanly to small isolated slices.
5. **No consumer forwards the whole `state` object as a prop** — every file reads discrete fields,
   so per-slice selectors are a drop-in with `useWorkspace()` kept as a thin shim during transition.

## Appendix B — Recommended Zustand slices *(feeds task 2)*

Reads/writes cluster into these slices (mirror `sessions-store.ts`; selectors with shallow compare):

| Slice | State | Actions | Hottest selectors |
|---|---|---|---|
| **chats** | `chats`, `activeChatId` | ADD / SET_ACTIVE / DELETE / ARCHIVE / UNARCHIVE / UPDATE_TITLE / UPDATE_SETTINGS / TOUCH / TOGGLE_PIN / HYDRATE_CHATS | `chatById(id)`, `activeChatId` (scalar), `terminalChats`, derived `activeFolder` |
| **drafts** | `chatComposerDrafts`, `emptyComposerDraft`, `editComposerDrafts` | SET/CLEAR_CHAT_DRAFT, SET/CLEAR_EMPTY_DRAFT, SET/CLEAR_EDIT_DRAFT | `editDraft(key)`; chat/empty mostly `getState()` |
| **handoff** | `pendingChatSubmission`, `pendingComposerAppend` | ENQUEUE/CONSUME (each) | `pendingSubmission`, `pendingAppend(chatId)` |
| **view** | `activePage`, `currentView`, `isLoading` | SET_ACTIVE_PAGE, SET_VIEW, SET_LOADING | `activePage` (scalar) |
| **project** | `project`, `projectGeneration`, `newAgentFolder` | CONNECT / UPDATE_STATUS / DISCONNECT_PROJECT, BUMP_PROJECT_GENERATION, SET_NEW_AGENT_FOLDER | `project`, `newAgentFolder`, `projectGeneration` |
| **aiSettings** | `aiSettings` | SET_AI_SETTINGS | `aiSettings` (mostly `getState()`) |
| **column3Tabs** | `column3Tabs`, `activeColumn3TabId` | ADD/REMOVE/ACTIVATE/REORDER/UPDATE_COLUMN3_TAB | `column3Tabs`, `activeColumn3TabId` |
| **selection** | `browserPickerSelection` | SET_BROWSER_PICKER_SELECTION | `browserPickerSelection` |

`elements` is legacy/empty (only `agent-chat` reads it, in an effect) — fold into **selection** or drop.

## Appendix C — Migration order *(feeds task 3 — cold → hot, atomic per surface)*

**Wave 1 — Cold slices + the 9 subscription-free consumers (lowest risk; proves the pattern).**
Stand up the new store with these slices and migrate: `column3` slice (`column3.tsx`,
`column3-tab-strip.tsx`), `project` slice (`auto-connect.tsx`), `aiSettings` (`HydrateAiApiKey` →
`getState()` at mount), `view` write-only (`settings-page.tsx`, `MainShellBody`,
`ReloadOnProjectChange`), and the read-on-demand consumers (`browser-tab.tsx`,
`column2-new-chat-menu.tsx`, `TabRow`, `AutoBindAgent`). After this wave 9 consumers subscribe to
nothing and 3 cold slices are off Context.

**Wave 2 — Wrapper hooks + scalar / derived readers (high leverage, medium risk).** Narrow
`use-active-workspace.ts` and `use-chat-cwd.ts` to return derived primitives; then
`column2-workspace.tsx` (activeChatId scalar), `column2-topbar.tsx` (derived folder),
`selection-sync.tsx` (browserPickerSelection), `turn-container.tsx` (editComposerDrafts[key]).

**Wave 3 — Hot core chat surfaces (most sensitive — migrate one at a time, profile between each).**
`agent-chat.tsx`, `column2-chat-view.tsx` (`Column2ChatView` + `ChatBody`), `column2-chat-tabs.tsx`
(`Column2ChatTabs`), `column2-terminal-deck.tsx`, `empty-composer.tsx`, `column1.tsx`,
`PreWarmAgents`, and **`ChatsPersistence` last** (owns chat persistence — verify reload + archive
afterward).

Delete `WorkspaceProvider` / reducer / Context only after Wave 3 (task 4).
