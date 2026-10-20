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
| Repository hub mode and each mode's selected tab                 | project id                           |
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

Cloud reload restores the saved workspace/chat identity before authentication
releases cached content. Only a confirmed chat snapshot for that exact cloud
workspace can invalidate its saved chat; the Local engine's list cannot. Do not
persist an early Local-only list over the cloud cache before its authorized
restore completes. Sign-out, account replacement and authoritative workspace
deletion prune the destination and its descendants atomically. A cold cloud
selection must not fall back to an unrelated Local chat.

Workspace existence and chat-history readiness are separate facts. Both Local
and Cloud wait for the selected workspace's first authoritative chat list before
automatically creating a default chat. A repository list arriving first is not
evidence of an empty conversation. Preserve the selection and drafts during
revalidation; a reload alone must not create an extra Untitled tab.

A Local transport reconnect observes the existing execution and prompt identity.
It never resends a possibly accepted prompt to repair a missing response. Keep
the live turn and elapsed clock while re-adopting, reject stale owner responses,
and use exact saved turn state when completion happened offline. Reconcile
missed transcript rows before draining a queued successor, retaining that wait
across repeated disconnects and failed reads. If backfill cannot be confirmed,
preserve and pause follow-ups. A terminated engine
cannot prove an unfinished operation was undelivered; retain the conversation
and surface recovery instead of starting the same work again automatically.

When a cloud engine stops or changes, new work must not reuse an admission that
is still disconnected or reconnecting. Reopen that workspace through normal
admission, deduplicate concurrent opens, and fence all late responses from the
retired connection. Keep its last confirmed chat snapshot until the replacement
hydrates successfully, including when hydration fails or the old native close
acknowledgement arrives late. Account replacement and owner deletion still
prune that snapshot; another workspace and the Local connection stay independent.

Cloud transport and compute lifecycle are separate facts. A ready or busy VM
does not become Starting when its socket disconnects. Short gaps keep the
existing quiet grace; longer gaps show Connecting or Reconnecting, and real
rejections and prolonged failures still use the existing error escalation.
Only lifecycle documents or an explicit Restart can report a compute transition.

An explicit cloud navigation, interaction or queued-send attempt owns one
ephemeral wake intent. Carry it through readiness retries, admission replacement,
and any preparation before enqueueing; allocate it only when the work begins.
A ready/busy preparation does not write a wake intent. It rechecks current
account, owner, access, Stop, lifecycle, live admission and physical root.
Explicit navigation arms the selected destination after its atomic selection,
including a different sidebar row or programmatic open. If idle capture commits
before admission, that existing two-minute interaction window waits for the
in-flight admission to settle, then follows the normal stopped-workspace wake
path. A later local Stop, owner/access change, hide, blur or expiry clears it.
Actual wakes retain their confirmed receipt across repeated preparations. The
receipt is never send authority: native commands retain their checkpoint and
execution fences.
An uncertain response retries the same idempotency ID and initiating reason;
a definitive refusal needs a new explicit attempt. Stop, account replacement,
owner deletion and the original attempt deadline retire old work. Cloud prompt
preparation spends at most ten seconds while the workspace is ready, and at
most 45 seconds including a wake. Serial history-conflict retries share an
eight-second bound and never retry a mutation or an uncertain dispatch.
Explicit Retry renews the intent; reconnect, catalog, history, hover and selection
restore never do. This identity stays in renderer memory, outside persisted
messages and provider commands. Local Personal and organization-local behavior
is unchanged.

Cloud catalog polling is not a transcript mutation. Retain the cloud history
revision and unchanged snapshot references, deduplicate concurrent history warms,
and notify chat/message consumers only when that exact workspace's confirmed
history changes. A history-only refresh must not invalidate Git, files or Local
state. This keeps stopped-workspace history readable without turning lifecycle
polling into a request loop across every retained chat.
Cloud transcript hydration is independent of the VM's admission/provisioning
gate. A retained active view whose session slot is cleared during authentication
or engine replacement rehydrates once its authorized chat metadata is available.
If it shared a read that retired after that cleanup, it retries once after the
read releases its identity. This recovery must not start an agent, wake a VM,
poll on ordinary failures, or reactivate a hidden surface.

Cloud presentation readiness is separate from authoritative transcript
hydration. An eligible account/org/workspace/chat cache window (at most 200
messages and 512 KiB) can paint while the session remains `loading`; it suppresses
Loading, but cannot authorize a send, queue drain or completion. Connected peers
with no message snapshot still use the parallel cache read. Cache misses,
eviction, denial and known incomplete/null/deleted heads remain truthful. Reads
carry their own verified head and CP/native source through the final await;
the currently connected peer is not proof of an earlier page's provenance.
Provisional rows do not mount native turn metadata reads or offer edit, reset,
fork, permission or retry actions. Their bounded cached window mounts rich
turns around the visible tail or saved reading anchor first, then on viewport
approach. All checkpoint anchors remain available for scroll-back; revealed
turns stay mounted within that existing window. Hidden surfaces suspend the
observer. Authoritative and Local turns retain their normal rendering, and
unchanged validation preserves visible message nodes and collection references.

The acceptance target for an eligible 200-row window is a visible paint under
100 ms during start or resume, measured on the minified production build. The
development-mode UI smoke (`scripts/ui-smoke-cloud-transcript-paint.mjs`) is a
regression guard with a looser bound, because development React is not the
shipped build.

A new authenticated boot may retain presentation only when the complete
immutable manifest, source, coverage, conversation and funding identity match.
Disk alone cannot prove a successor. Binding changes still retire read and
confirmation tokens and rotate the durable history nonce; old writes cannot
restore retired bytes. Projection revisions are not compared across bindings.
Changed source/edit/delete/incomplete heads invalidate incompatible rows before
paint. Unchanged validation keeps message references. Local Personal and
organization-local hydration remain authoritative. Closed cache outcomes/head
facts and visible-paint/loading durations enter cloud diagnostics without
content, hashes or durable owner/conversation identifiers.

Local presentation readiness follows the same rule without the cloud fences.
Local Personal and organization-local chats keep their last confirmed window
in a bounded Local transcript cache: the exact message objects of chats that
left the retained deck (memory, at most 16 chats and about 16 MiB) and an
IndexedDB copy in the purgeable Chromium profile (at most 96 chats and 40 MiB;
200 rows and 768 KiB per chat, least recently read first out). A cold Local
chat paints that window as provisional `transcriptPresentation` in its first
visible frame: ChatView publishes a memory copy from a layout effect, the
hydrate paints a disk copy as soon as it is read, and the boot chat's copy is
read before React renders. Provisional rows are read-only and never authorize
a send, queue drain, edit or completion; the engine window replaces them while
keeping every unchanged message reference. A chat minted by this renderer is
known to be empty and starts resident without a read. Minted and
engine-confirmed empty chats are also remembered across launches (at most 128
ids in local storage), so after a restart such a chat paints its empty state
provisionally (`transcriptPresentation.empty`) instead of "Loading
conversation…" while the engine starts. Any message or history hint removes
the id synchronously, and the engine read still confirms the paint. Copies are written once
a turn settles or a window leaves memory, never per streamed chunk; reset,
delete and the authoritative chat snapshot prune them. Cloud chats never enter
this cache. A confirmed empty resident window invalidates both cache tiers
immediately, before eviction or app shutdown can bypass a delayed capture.
An empty cold or loading slot is not confirmation and cannot erase the cache.

A Local window can begin inside one long turn: the engine snaps a tail window
back to its opening prompt only within its 1000-row budget. Beyond that, the
Local engine reports the opening beside the contiguous rows (`turnOpening`),
and the slot keeps it as `leadingPrompt`, outside `messages`, so paging
cursors, caps and equality keep their meaning. Every front trim, older-page
prepend and window replacement re-derives it, editing it cuts every resident
row, and the turn renders with its prompt, checkpoint and footer. Match the
front by stable message ID when a live update replaces its object. Explicit
Retry may use the leading prompt only from a confirmed resident window and
must revalidate it after each await; a newer inline prompt takes precedence.

An empty chat's provenance block (workspace rows, or "Add chat transcripts"
when another chat in the folder has a prompt) never waits blank on the
transcript list. Local folders share one list per folder: every empty chat
reads the same snapshot and drops itself locally, so a new or returning tab
paints a list another tab already confirmed, and only the visible empty chat
reads. The last list per folder is persisted (24 folders, 32 rows, 120-character
summaries) as paint-only data; the first mount after a restart still asks the
engine once. A prompt sent from this renderer appears as a pending row at once
and yields when the engine reports that many prompts or later activity for the
chat; an unconfirmed row expires after two minutes. With nothing known, the
workspace rows stand in after a 400 ms grace and the transcript row replaces
them when the list lands. Cloud folders keep their exact (folder, excluded
chat) read.

Sending immediately after Stop may race the cancelled command's durable
retirement. Resume can retry only when the entire revision advance is accounted
for by the same dispatching commands becoming terminal. A newer Stop, recovery,
or queue edit still rejects the stale send. Native completion remains immediate;
waiting for persistence must not keep the completed turn's timer running.
Archived workspaces and pending provider storage deletion use the normal catalog
cadence; neither keeps all workspaces on fast setup polling. Actual startup and
interactive lifecycle transitions still receive fast refreshes.

The account catalog owns one next-due timeout: 30 seconds for stable rows and
2 seconds during those transitions, measured from the read's monotonic start.
Catalog events update the due time; focus and visibility events coalesce with
that same read. Hidden, signed-out, disabled and pending-network states have no
passive timer. A slow transcript-cache read does not delay the catalog fallback;
after it resolves, recheck workspace eligibility before restoring chat metadata.
Switching A → B → A retires each request identity, so an old response cannot
clear the current flight, restore another owner's chats or schedule its timer.

Runtime availability uses one observer per account/catalog/workspace/generation
key, shared by the composer and workspace details. Stable visible surfaces use
a 30-second fallback; open details retain the existing 5-second VM-startup and
2-second runtime-transition cadence. Hidden or inactive surfaces do not start
reads, poll, or focus. In-flight reads suppress passive timers, and foreground
events coalesce with an existing cache refresh without postponing its deadline.
Keep the confirmed exact-key snapshot through refresh failures and honor data
warmed on intent. Passive observation never wakes or upgrades a workspace.

Setup observation also requires a visible window: the output view, off-tab
status dot and chat provenance stop passive reads while hidden. A retained
Setup view cancels its 900 ms running poll and 2 s first-snapshot retry, keeps
its confirmed exact-workspace output, and catches up on reveal. In-flight
invalidation queues cannot start hidden or retired reads, and a superseded
response cannot replace that confirmed output. Reveal during an old flight
coalesces one fresh read. Log reconciliation appends only an exact extension of
the confirmed prefix; a hidden rerun may replace it with an equal or longer log
without the observer seeing the intermediate empty snapshot. The visible
fallbacks and engine-owned setup process continue to have their existing
behavior; hiding the window never stops setup.

Provider Information also requires both an active surface and a visible
document. Its 30-minute usage fallback and one-minute reset-label clock are
removed while hidden; focus cannot initiate a hidden usage read. Reveal
refreshes the exact provider/method/account/auth-revision/identity cache and
updates elapsed reset labels immediately, retaining confirmed usage through
the shared request. Explicit Refresh, the 25-second native request timeout and
five-minute automatic-failure backoff keep their existing behavior. This is
the native account information surface; organization provider connections
retain their separate cloud contract.

The organization settings courier uses one visible-only 15-minute fallback
and a 30-second focus freshness guard. Reveal catches up once when stale or
invalidated; explicit settings and membership invalidations coalesce into one
trailing read. Hidden windows and pending observations have no passive timer;
every asynchronous tail rechecks visibility, the observation epoch and the
account-store generation.
Owner changes, account resets and sign-out still clear the Local engine context
immediately while hidden. A late A → B → A response or clear acknowledgement
cannot revive the old context; ordinary same-owner refresh failures retain the
confirmed settings. Personal remains device-local and this courier never
addresses a cloud VM. Local ownership migration retains its existing path.

Deletion cleanup follows semantic path ownership, not raw equality: include
normalized descendant cwd keys, but protect a separately registered nested
repository (the most-specific known owner wins).

New in-app folder opens ask for confirmation when Git is absent. Dismissal must
not register the folder or mutate Git. Confirmation re-inspects the exact root,
initializes local Git and an initial commit when needed, then creates or reuses
a managed worktree. Create uses the same Git preparation.
Do not create original-folder chats as an error fallback or a default repository
switch destination. Unknown inspection results are errors, not non-Git folders.
Opening an external deep link only registers the project; startup and resume
inspection are read-only. The retired direct-folder preference is ignored.

Local Git repositories list only managed workspaces. Saved chats, workbench
state, selections and the retired direct-folder setting never restore the
synthetic `main` workspace, including for older project records without a
confirmed `isGitRepository` snapshot. Once its exact workspace list settles, a
saved checkout selection opens an available worktree or the empty repository
page. Cold nested paths still await managed-worktree ownership validation.
Existing chats and files remain stored at their original paths.

Previously opened plain folders retain their `local:<repoSlug>` identity.
`useFolderWorkspaces` projects them only when saved chats, workbench state or
selection already refer to them. This includes saved subdirectories, preserves
their exact navigation cwd, and assigns nested paths to their most-specific
registered owner. A nested Git repository cannot revive its parent's folder
row. This projection never enters managed-workspace caches or engine lifecycle
calls. Cloud primary workspaces retain their remote catalog identity.

Desktop app resume uses one capability observer with two concurrent folder
inspections, coalesced focus/visibility events and exact-owner in-flight
deduplication. Persist only confirmed Git/origin snapshots, preserving identity
and references on no change. Reject obsolete responses after local writes or
owner removal. Missing paths, permission/config failures and unavailable Git
are errors, not evidence that Git or an origin was removed. Both Review entry
points (summary and tab strip) share the same capability predicate.

Legacy plain folders are standalone sidebar rows in both Grouped and
Ungrouped: never paint a repository header or group for them, because the
folder row already names the repository. A folder without workspace history
opens its settings directly; listing or selecting it never creates a workspace
or chat. Ungrouped places these unopened folders after workspace rows, in
registration order. Their settings expose Environment, Actions,
and Paths; Workspaces, Git, Files-to-copy, worktree lifecycle scripts, workspace
storage paths, and the archive picker require Git. File browsing remains
available in the workbench. Resolve an unavailable saved settings view to
Environment synchronously without overwriting the preference, and evict retained
Git-only views when capability disappears. A confirmed local Git repository
gets the full settings navigation even without an origin or GitHub connection.

### 1.2 App sidebar navigation

One left sidebar replaces the former top bar and Home rail on every page except
Settings, which takes its place with its own section nav. The sidebar stays
mounted (hidden and inert on Settings, with its polling resource monitor
unmounted and row Git reads suspended) because it also owns the app-wide
keepers: project sync, settings prefetch, run-activity sync, idle file warming,
and validation of a remembered workspace once its exact repository list settles.

- Its 40px title band holds the macOS traffic lights, the panel-left toggle
  right after them, and drags the window. Resources, Go back and Go forward sit
  at its end as 28px icon buttons; these four controls set the sidebar's 220px
  floor. Resource totals remain available in the tooltip and details popover.
- Go back and Go forward step through the destinations shown this session:
  Home, Customize, Create, repository pages and workspaces, however they were
  reached. Settings is never an entry, and chat, workbench and repository hub
  tabs stay with their own owners. The history is in-memory and bounded,
  restarts when another organization becomes active, and skips without pruning
  a repository or workspace the sidebar no longer lists. Each step reuses the
  sidebar's own open actions, and pointer or focus intent warms its target. A
  step with nowhere to go is `aria-disabled`, not disabled, so a quick second
  click cannot fall through to the title band's double-click zoom.
- The organization switcher names device Personal "Local" and sizes to its
  label, truncating long names. Destinations are Home (the Dashboard) and
  Customize; Create is an action and, like a repository's +, never paints as
  selected. The profile row opens Settings. Rows are 30px, labels 13px, with 2px
  between repository and workspace rows; repository names and workspace glyphs
  stay on fg2. Adding a repository lives on Create, the welcome view and the
  menu bar.
- Collapsing is one persisted app preference. The sidebar stays mounted but
  hidden; the traffic lights and the toggle then float over the content's
  top-left corner at the same position, the first chat strip reserves that
  corner in its leading slot, and Home pages start below it.
- Workspaces are Grouped by default: every registered Git repository is a
  header (even with no workspaces), with its in-flight creates and workspaces
  newest first. Ungrouped is one mixed newest-first list whose rows lead with
  their repository icon and trail with agent state. These are the only two
  presentations; a persisted Active or repository-only filter folds into
  Ungrouped or Grouped when painted and is written back once.
- A header's icon becomes its disclosure chevron on hover; + (Create for that
  repository) is always visible; settings and ⋯ (Create workspace, Create from…,
  Configuration, Remove repository) appear on hover or keyboard focus.
  Collapse belongs to the repository id, is bounded and pruned on removal, and
  never hides the selected workspace.
- Selecting a workspace from Home or a deep link reveals its row, including
  returning to the same workspace after leaving it. Unrelated refreshes and
  hiding/showing an unchanged selection preserve manual scroll.
- Create from… publishes the Create route and project atomically; the "open
  the source picker" intent is ephemeral and is consumed or dropped as soon as
  Create shows (or cannot show) that repository.

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

### Create workspace source selection

Create's project, source and Code/Design controls share one row above the prompt,
with mode aligned right and long labels truncated in narrow windows. The project
picker also owns Open project, Open GitHub project and Start from scratch. These
actions register and select their project while keeping Create and its draft open.
Workspace creation waits for submission, as does Git preparation for opened
folders. Opening a linked worktree here selects its primary repository without
adopting a workspace.
Welcome, sidebar and native-menu opens retain their immediate workspace flow.
The source picker separates local branches from the configured remote's branches,
shows the actual default branch, and retains each tab's confirmed rows independently
of GitHub requests. Issues remain unavailable until issue creation is supported.
Catalog keys include the checkout root and observed origin; local branch keys
include the checkout root and repository slug. Intent warms local metadata;
only the selected project refreshes its remote catalog. Ref-change signals
refresh local metadata without recursively triggering another network fetch.
The shell's persistent settings listener invalidates both catalogs even while
Create is unmounted; inactive catalogs wait for their next consumer to refresh.

An explicit source selection belongs to its project/root/origin and cannot
carry over to a different owner. Branch selections send fully qualified Git
refs to distinguish local and remote namesakes, while workspace metadata retains
plain base branch names. Choosing the default leaves base resolution to the
engine, preserving its fresh-remote and offline fallback behavior. Both Create
and workspace prompt cards rest at 106px with 18px corners; longer prompts grow
to the editor's existing 200px scrolling cap.

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

Per-file diff intent has two concurrent prefetch slots across the renderer and
keeps only the newest waiting target. This matters for large change sets whose
aggregate response contains summaries without patches. Explicit file selection
bypasses the speculative slots and shares an already-running exact-key read.
Hidden retained file viewers subscribe to cached results without initiating
reads, even when cold; otherwise they bypass the intent budget on every hover.

### 4. Retain expensive DOM selectively

Finished transcript, editor, xterm, iframe, and virtualized-diff trees can be more expensive to reconstruct than to hide. Keep the common round trip mounted in a bounded MRU deck.

- The active layer is visible and interactive.
- Hidden layers use `inert`, `aria-hidden`, no pointer events, and no visibility.
- Gate global shortcuts, focus restoration, polling, measurement, and other active-only effects.
- Give every deck a hard entry bound. Eviction is the cold-path fallback.
- Keep retained iframe sibling order stable. MRU order may choose eviction, but
  physically moving an already-mounted iframe reloads its nested browsing
  context in Chromium and destroys form, scroll, media, and JavaScript state.
- Do not retain cheap or unbounded surfaces merely for consistency.

Current deck helpers live in `apps/desktop/src/renderer/shell/retained-view-keys.ts` and `apps/desktop/src/renderer/shell/use-retained-view-keys.ts`.

Background-task elapsed labels share `state/use-visible-clock.ts`: one timer
per renderer with visible consumers, none when the document is hidden or all
consumers are inactive. Reveal samples wall time immediately; elapsed state
still comes from each chat's own `startedAt`. Snapshot reads do not advance or
consume a pending publication. This display clock never controls task,
authentication, or request deadlines, which retain their own authority.

### 5. Preserve identities through hot renders

- Zustand consumers select the narrowest scalar/immutable slice they render. Event handlers read `store.getState()` when they do not need a subscription.
- Do not return fresh arrays or objects from a hot selector unless using a deliberate equality function.
- Structurally share unchanged historical chat turns and rows.
- Memoized list rows receive row-local booleans such as `isSelected`; passing the whole selected id causes every row to fail memo equality.
- Virtualize unbounded files, transcript, and diff content. Keep syntax highlighting off the main thread where supported.

Transcript following tracks reader intent separately from scroll geometry.
“Jump to latest” resolves the current content bottom after smooth scrolling;
intermediate animation events are not evidence that the reader scrolled away.
Follow asynchronous layout growth while at the tail, exclude checkpoint blank
space, and cancel navigation on a reader gesture. Each new navigation cancels
older corrections on that exact scroller. Hidden surfaces never measure
or change that intent. Older history merges into the current exact-chat snapshot
and preserves a visible anchor, so concurrent tail growth cannot move the reader.

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

The [Design renderer contract](design-mode-roadmap.md#renderer-and-editor-contract)
owns the feature-specific gestures, source transactions and runtime limits;
the interaction rules here apply across renderer features.

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

### 6.1 Floating menus and pickers

Context menus keep a pointer offset relative to their live source element, in
renderer CSS pixels. Moving or resizing a pane recomputes that point; canvas
anchors also scale with zoom. Do not retain an event's client coordinates as a
permanent anchor or mutate the event to position a menu below its trigger.

Use the shared menu, popover and Select primitives for portals, viewport
collision handling, and available width/height limits. Feature-specific maximum
sizes must take the minimum of their preferred size and the primitive's available
size. Submenus portal out of the parent menu's scroll container. Select preserves
its layout-column boundary and dismisses on window resize.

External surfaces such as the file tree retain ownership of selection and
dismissal, but supply the shared context menu with a live row anchor. Mark a
portaled file menu with `data-file-tree-context-menu-root="true"` so the tree
recognizes internal clicks. Disappearing, hidden or inactive owners dismiss their
menus; anchor tracking runs only while open. The canvas invalidates pending hit
tests when its workspace or active state changes.

`scripts/ui-smoke-overlay-positioning.mjs`, included in `pnpm test:ui-smoke`,
exercises pane movement, window resizing, constrained menu scrolling, submenus,
keyboard focus, retained file-tree owners and canvas anchors in Chromium.

## Zeros implementation map

- Workspace route + target: `OPEN_WORKSPACE` in `apps/desktop/src/renderer/state/workspace-store.ts`.
- Scoped navigation memory: `lastWorkspaceByRepoRoot`,
  `repoPageViewByProject`, `repoPageViewByModeByProject`, `lastHomePage`, and per-worktree `WorkbenchTab` fields
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
- Conversation Summary: `apps/desktop/src/renderer/shell/conversation/conversation-summary.tsx` owns the chat strip's Summary popover and the island beside its top-right pane when Workbench is collapsed. Narrow panes and layouts with side-by-side chat columns keep the popover, bounded inside its owning pane with a 16px right inset; the island reserves body space without remounting chat. Both presentations share Context, run-preview and All Changes data, dismiss on owner changes, and stop active reads when hidden. Starting an Environment action leaves Summary visible; its preview opens the exact URL in the workspace's Browser.
- Changes file retention/prefetch: `apps/desktop/src/renderer/shell/workbench/tabs/changes-surface.tsx`.
- Browser retention: the bounded, cross-workspace iframe deck in `apps/desktop/src/renderer/shell/workbench/workbench-pane.tsx`; retained browser updates carry their original workspace scope.
- Terminal retention: the bounded folder/session deck in `apps/desktop/src/renderer/shell/workbench/tabs/terminal-tab.tsx`, with stable portal hosts across main-tab and bottom-panel placement (see `docs/terminal-workbench.md`).
- Settings/repository retention: bounded visited-section decks in `apps/desktop/src/renderer/features/settings/settings-page.tsx` and `apps/desktop/src/renderer/features/repositories/repo-page.tsx`.
- One-paint transition suppression: `apps/desktop/src/renderer/shared/ui/use-instant-view-switch.ts`.
- Chat structural sharing: `apps/desktop/src/renderer/features/agent/stable-turns.ts`.
- Local transcript cache: policy in `apps/desktop/src/renderer/state/local-transcript-cache.ts`, IndexedDB records in `apps/desktop/src/renderer/platform/local-transcript-store.ts`, provisional paint and fresh chats in `apps/desktop/src/renderer/features/agent/local-transcript-presentation.ts`.
- Empty-chat transcript row: shared Local folder list, persisted paint and pending prompts in `apps/desktop/src/renderer/features/agent/use-chat-transcript-summaries.ts`; the grace in `agent-chat.tsx`.
- Long-turn opening prompt: `windowChatMessagesPage` in `apps/desktop/src/engine/db/messages.ts` and `apps/desktop/src/renderer/features/agent/transcript-leading-prompt.ts`.
- Engine start attribution: `apps/desktop/src/engine/boot-phase-timer.ts` names slow phases on the "Engine ready" line.
- Local streaming transcript writes: "Streaming write coalescing" in `apps/desktop/src/engine/db/messages.ts` buffers each streamed row for 150 ms (newest version wins); every read, write or delete of that chat's rows drains it first, prompts stay write-through, and cloud workers keep write-through persistence.

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
