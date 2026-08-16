# Instant UI interaction architecture

> Status: active engineering standard, 2026-07-17.

Zeros should feel like a local IDE: a warm tab, file, chat, workspace, or settings destination appears in the next paint as one complete surface. At 60 Hz that means targeting a single 16.7 ms frame, not a literal 10 ms opacity animation.

Once local and network reads are no longer the dominant cost, unstable React
identities, unnecessary commits, repeated parsing/highlighting, and work left on
the interaction path become the bottleneck. This standard addresses those costs
directly.

## Required architecture

### 1. Publish navigation atomically

One user action must publish the route and its destination identity in one store update. Subscribers must never observe “new workspace + old chat” or “new repository + empty settings target” between sequential dispatches. Derive visible state during render; do not repair it in a passive effect.

### 1.1 Give every selection an owner

A selected tab is durable navigation state when users expect an A → B → A
round trip to restore it. Key it by the smallest semantic owner that can vary:

| Selection                                                        | Owner key                            |
| ---------------------------------------------------------------- | ------------------------------------ |
| Home destination or app-wide presentation preference             | app                                  |
| Repository hub tab                                               | project id                           |
| Selected workspace                                               | repository root                      |
| Active chat, workbench tabs, Changes/Review choices, terminal tab | workspace folder                    |
| Open file and explicit viewer mode                                | workbench tab id inside the workspace |
| Dialog step or unsaved “new item” draft                          | ephemeral; do not persist            |

Restore durable selections synchronously from the destination's first store
snapshot. Do not seed a repository/workspace-scoped tab from component-local
`useState`, one global settings key, or a passive-effect hand-off. An explicit
deep link publishes route, owner identity, and nested destination together.

Persisted owner maps are a storage/cache surface: type-guard them, give them a
hard bound, and prune entries when their repository/workspace is removed. A
remembered server-backed target is invalid only after the matching exact-key
snapshot settles and proves it missing. `undefined`/cold is not an empty list;
keep the remembered identity while revalidating, then apply an authoritative
fallback as a new atomic navigation if necessary.

Deletion cleanup follows semantic path ownership, not raw equality: include
normalized descendant cwd keys, but protect a separately registered nested
repository (the most-specific known owner wins).

### 2. Treat reads as exact-key server state

Bridge, native IPC, Git, SQLite, and future cloud/sandbox reads are shared server state, not component-local loading state.

- Key snapshots by every field that changes their meaning: repository/workspace, path, scope, commit, turn, and content revision.
- Deduplicate concurrent reads.
- Keep the last successful exact-key value visible during refresh (stale-while-revalidate).
- Reject stale generations after writes or invalidation.
- Preserve collection references when refreshed values are equal.
- Bound inactive entries and define invalidation events.

`apps/desktop/src/renderer/shared/lib/keyed-async-cache.ts` is the renderer primitive for this pattern. Feature caches choose keys, fetchers, freshness, and invalidation. For a popover/dialog/settings surface, mount a shared cache key with `apps/desktop/src/renderer/state/use-cached-read.ts` against a cache declared in `apps/desktop/src/renderer/state/read-caches.ts` — never the clear-then-fetch shape (`setLoading(true)` + fetch in an on-open effect), which blanks rows the user already saw and refetches data fetched seconds ago.

Two rules that pattern enforces:

- **Opening a surface is not an invalidation.** A dropdown open, tab switch, or component remount reads the cached snapshot and revalidates only past the key's freshness window. Only real change signals (DB change bus, `notifyWorkspacesChanged`, an explicit user Refresh, a bridge *re*connect) force a read. `onActiveBridgeConnected` reports `initial: true` for its subscribe-time fire — treat that as "revalidate if stale", never "force".
- **Results that survive restarts should be persisted.** Expensive, rarely-changing detections (e.g. the automatic repository icon in `apps/desktop/src/renderer/features/repositories/repository-icons.ts`) persist to settings storage and revalidate at most once per app session, so a cold start renders them with zero fetches.

### 2.1 Preserve Git's index/worktree semantics

Git status is a two-column state machine, not one changed-file list. Each Changes
scope must be computed from its own comparison and must use that same comparison
for both rows and counts:

| Scope       | Authoritative comparison                                                      |
| ----------- | ----------------------------------------------------------------------------- |
| All Changes | branch fork point → current working tree (committed + uncommitted net result) |
| Uncommitted | `HEAD` → current working tree (net result)                                    |
| Staged      | `HEAD` → index                                                                |
| Unstaged    | index → current working tree, plus untracked files                            |

Porcelain status may enrich authoritative patch rows with conflicts, rename
metadata, and lifecycle styling. It must not generate a net-scope list or count
by unioning/summing its buckets. For example, a newly staged file later removed
with plain `rm` is `AD`: it is one Staged addition and one Unstaged deletion,
but it is absent from All Changes and Uncommitted because the current filesystem
is identical to `HEAD`. The Changes badge always reports All Changes.

External source changes have two refresh paths. Working-tree create/edit/delete
events and per-worktree/shared Git metadata changes (index, HEAD, fetch refs,
packed refs, reflogs) invalidate the exact opaque workspace key. External
GitHub activity cannot trigger a filesystem event, so active PR surfaces refresh
on app resume and on a bounded visible-only poll. On app launch, every surface
revalidates its exact key; while the app is closed there is no renderer to
update.

Changes owns a durable viewer selection: first confirmed list selects its first
row; when the selected row disappears, select the next surviving row in the
prior order, then the nearest previous row. A standalone File tab remains open
and reports that the file no longer exists. Never overwrite an unsaved draft.

Changing a PR target updates target metadata only. Rebasing or merging the
working branch is a separate explicit operation; a picker action must never
implicitly autostash or rewrite history.

### 3. Move work before or after the click

Pointer-enter and keyboard-focus intent should warm the exact likely destination. A click performs the urgent selection only; it must not await I/O, parsing, highlighting, or hydration.

Reuse aggregate responses. If Changes already parsed a whole-worktree patch, publish each per-file patch to the viewer cache instead of starting a second Git process on selection.

Bound speculative work. Warm a small first window during idle time and use intent for the rest; never prefetch an unbounded repository.

### 4. Retain expensive DOM selectively

Finished transcript, editor, xterm, iframe, and virtualized-diff trees can be more expensive to reconstruct than to hide. Keep the common round trip mounted in a bounded MRU deck.

- The active layer is visible and interactive.
- Hidden layers use `inert`, `aria-hidden`, no pointer events, and no visibility.
- Gate global shortcuts, focus restoration, polling, measurement, and other active-only effects.
- Give every deck a hard entry bound. Eviction is the cold-path fallback.
- Do not retain cheap or unbounded surfaces merely for consistency.

Current deck helpers live in `apps/desktop/src/renderer/shell/retained-view-keys.ts` and `apps/desktop/src/renderer/shell/use-retained-view-keys.ts`.

### 5. Preserve identities through hot renders

- Zustand consumers select the narrowest scalar/immutable slice they render. Event handlers read `store.getState()` when they do not need a subscription.
- Do not return fresh arrays or objects from a hot selector unless using a deliberate equality function.
- Structurally share unchanged historical chat turns and rows.
- Memoized list rows receive row-local booleans such as `isSelected`; passing the whole selected id causes every row to fail memo equality.
- Virtualize unbounded files, transcript, and diff content. Keep syntax highlighting off the main thread where supported.

### 5.1 Direct manipulation: one authority per pixel

A drag on the design canvas has two sources of truth for the same geometry — the
pointer, which the host can paint immediately, and the real element inside the
sandboxed runtime, which only layout can answer. Any surface that draws over live
content inherits these rules.

- **Author whole pixels, then paint what you authored.** A gesture writes integer
  CSS values; painting the pointer's own fractional rectangle leaves the overlay
  half a pixel from the element at 1× and four at 4×. Worse, rounding an offset
  and a size independently makes the edge the user is *holding still* oscillate a
  full pixel twice per pixel of travel. Quantize the two **edges** of an axis, not
  the (position, size) pair — an edge the pointer is not moving must not move at
  all (`designAuthoredResizeAxis`).
- **One request in flight, newest input wins the next slot.** Never queue a
  backlog of pointer samples. With a single flight the runtime holds exactly the
  styles of the request that just answered, so its measurement *is* the element as
  it stands and painting it is always safe — which is what lets an overlay settle
  onto the truth instead of racing ahead of it
  (`design-workspace/design-gesture-loop.ts`).
- **Ask the pointer-path question, not the inspector's.** A gesture repaints one
  outline, four padding hatches and the gap handles: a dozen values. Reuse of a
  full node-details call costs ~130 computed properties per node per frame, and a
  second child-enumeration call behind it doubles the round trip. Give the gesture
  path its own lean method, measured synchronously in the same task as the write —
  no animation frame between applying a style and reading the result
  (`previewGeometry` in `packages/protocol/src/design-runtime.ts`).
- **Never read layout on the pointer path.** One `getBoundingClientRect()` in a
  `pointermove` handler forces a full style+layout pass on a document that also
  hosts every live iframe. Containment and hover questions belong to CSS.
- **A gesture must not publish to a store.** The surface being dragged paints
  itself; publishing per frame re-renders every subscriber for values nobody is
  reading yet. Mirror them into panels at a readable rate (~10 Hz) and always
  publish the released value, so what a panel shows is exactly what the commit
  will prune (`publishDesignGestureLivePreview`).
- **Imperative paints must respect React's nodes.** `replaceChildren` and
  `textContent` detach the text node React's fiber points at; React's next update
  then writes into a node that is no longer in the document and the label silently
  freezes. Write `firstChild.nodeValue`, and render such labels as a single
  interpolated child. Any property a paint may set (`visibility`) must also appear
  in the React style object, or a transient value outlives the gesture.
- **A gesture's own modifiers must not unmount what it is painting.** Option means
  "resize from center" *and* "measure"; if the measure overlay replaces the
  constraint guides mid-drag, the gesture paints into a detached node. Gate such
  swaps on there being no active gesture, and never key a live overlay by array
  index.

### 5.2 Typed input is a draft; commit is the event

An input in an inspector is not a slider. Applying a value per keystroke reflows
the document through every intermediate string — including the empty one a
backspace leaves behind, which *removes* the declaration — and makes the element
and its chrome disagree for a frame each time.

- Typing (and arrow-stepping) updates local state only. `Enter` commits, `Escape`
  restores the focus-time baseline, and blur commits as the standard fallback.
- The commit paints once, immediately, before the source round trip settles, so
  the confirmation is in the same frame as the keypress.
- Direct manipulation stays live: label scrubs, sliders, colour-area drags, and
  canvas gestures preview continuously and commit on release.
- A single click on a select, segment, or preset *is* an explicit change: apply it
  immediately.

### 6. Motion must not mask readiness

Global fades delay a ready UI and expose blank intermediate states. Context switches suppress incidental layout/color transitions for the replacement paint, so persisted widths, text, and rows snap to their destination together. Scope that suppression to the changing surface; a document-wide class forces style recalculation across unrelated columns.

A busy indicator may be delayed roughly 100–120 ms to avoid a flash for a fast cold read. If the delay expires, show the honest loading state. Never use a fixed one-second fade or spinner as a substitute for caching and prefetching.

## Zeros implementation map

- Workspace route + target: `OPEN_WORKSPACE` in `apps/desktop/src/renderer/state/workspace-store.ts`.
- Scoped navigation memory: `lastWorkspaceByRepoRoot`,
  `repoPageViewByProject`, `lastHomePage`, and per-worktree `WorkbenchTab` fields
  in `apps/desktop/src/renderer/state/workspace-store.ts` / `apps/desktop/src/renderer/shell/workbench/tab-model.ts`.
- Shared workspace/settings caches: `apps/desktop/src/renderer/state/use-projects.ts` and `apps/desktop/src/renderer/features/settings/use-settings.ts`.
- Picker/dialog read caches (branches, PRs, workspaces, GitHub auth/owners): `apps/desktop/src/renderer/state/read-caches.ts` mounted via `apps/desktop/src/renderer/state/use-cached-read.ts`.
- Persisted repository-icon cache (restart-proof, once-per-session revalidate): `apps/desktop/src/renderer/features/repositories/repository-icons.ts`.
- Exact Git scope rows/counts + coalesced generations: `apps/desktop/src/engine/git/diff.ts` and `apps/desktop/src/renderer/shell/workbench/tabs/changes-tab.tsx`.
- External worktree/index/shared-ref invalidation: `apps/desktop/src/engine/git/watch.ts` feeding the exact-key bus in `apps/desktop/src/renderer/shell/use-git-refresh-key.ts`.
- PR-status island freshness gate + active-only resume/poll refresh: `apps/desktop/src/renderer/shell/pr/pr-status-island.tsx`.
- File list cache: `apps/desktop/src/renderer/shell/workspace-files-cache.ts`.
- File content/diff cache: `apps/desktop/src/renderer/shell/workspace-file-data-cache.ts`.
- Workspace intent warming: `apps/desktop/src/renderer/shell/prefetch-workspace-surface.ts`.
- Chat retention: `apps/desktop/src/renderer/shell/conversation/chat-deck.tsx` with store-owned pane hosts.
- Changes file retention/prefetch: `apps/desktop/src/renderer/shell/workbench/tabs/changes-surface.tsx`.
- Browser retention: the bounded, cross-workspace iframe deck in `apps/desktop/src/renderer/shell/workbench/workbench-pane.tsx`; retained browser updates carry their original workspace scope.
- Terminal retention: the bounded folder deck in `apps/desktop/src/renderer/shell/workbench/tabs/terminal-tab.tsx`.
- Settings/repository retention: bounded visited-section decks in `apps/desktop/src/renderer/features/settings/settings-page.tsx` and `apps/desktop/src/renderer/features/repositories/repo-page.tsx`.
- One-paint transition suppression: `apps/desktop/src/renderer/shared/ui/use-instant-view-switch.ts`.
- Chat structural sharing: `apps/desktop/src/renderer/features/agent/stable-turns.ts`.

## Review checklist

For every new tab, route, settings section, or workspace-scoped surface:

1. What is the complete semantic cache key?
2. What exact snapshot is available in the destination's first render?
3. Which intent event can begin the load before click?
4. Is any duplicate bridge/Git/parse/highlight work performed after selection?
5. Which component identities remain stable during unrelated store/stream updates?
6. If DOM is retained, what is the bound, eviction behavior, and inactive-effect gate?
7. Does refresh preserve confirmed data and reject an old response after invalidation?
8. Does the interaction produce one localized React commit in the Profiler?
9. Who owns the selection, and does A → B → A restore it without leaking A's
   value into B?
10. What validates a deleted/corrupt remembered target, and can a cold cache be
    distinguished from an authoritative empty snapshot?

Required automated coverage includes exact-key isolation, concurrent-request deduplication, stale-while-revalidate behavior, invalidation races, stable reference reuse, bounded eviction, A → B → A restoration, reload, owner deletion, corrupt values, and one-notification atomic navigation. Manual profiling should exercise workspace, chat, Files, Changes, Review, terminal, repository settings, and Home/workspace round trips.
