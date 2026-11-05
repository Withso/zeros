# Canvas audit: Zeros Design against the app

Status 2026-11-05, Zeros Design canvas version 373.

## How to read this

Each canvas frame shows one of two things:

- **The shipped UI.** The frame has no badge.
- **A Planned badge.** It names what is left and the `plans.md` section that
  owns it.
- **A Reference badge.** A layout kept for later, not planned work:
  RevProviders, the rows GitLab and Bitbucket would fill.

Earlier rounds verified the unbadged frames against the code. They rendered
every state in both themes, and the ui-smoke registry measures the looks the
frames pin. This round built `plans.md` §3 to §7 and checked each frame they
owned against the app in both themes before its badge came off.

Counts come from the canvas: `canvas.json` and each frame's plan line. The
canvas's 91 notes are section titles. Implementation notes live in the frames
and in [`plans.md`](plans.md).

## By page

| Page | Frames | Planned | What is left |
|---|---:|---:|---|
| UI components | 47 | 0 | — |
| Foundations | 14 | 0 | — |
| Branding | 4 | 0 | — |
| Web app | 55 | 0 | — |
| Agent chat | 87 | 0 | — |
| Sidebar | 25 | 0 | — |
| Dashboard (Home) | 18 | 0 | — |
| Files tab | 7 | 0 | — |
| Changes tab | 35 | 0 | — |
| Review tab | 26 | 7 | §1 leftovers, listed below; RevProviders is a Reference |
| Design tab | 28 | 0 | — |
| Terminal | 19 | 0 | — |
| Browser | 16 | 0 | — |
| Simulators | 12 | 0 | — |
| Customize | 25 | 0 | — |
| Settings | 36 | 0 | — |
| **Total** | **454** | **7** | |

## Landed this round

- **§3 Hunk review is gone.** Diffs carry comments only, in Changes and in a
  Files tab's diff; `git.reviewHunks`, `git.reviewHunk`, their decision store
  and the protocol's hunk schemas are removed.
- **§5 Diff rows.** The + or − sits in the number's padding, the change bar is
  a solid 2px, a new or untracked file keeps its bars without the row wash,
  and the caret line lifts by fg1 5%.
- **§6 Comment authors.** People show a photo or initials, agents their mark
  with an Agent badge, review apps their logo with a Bot badge; Local and
  cloud threads both carry the sanitised GitHub avatar.
- **§4 Conflicts in place.** Each block is marked in its rows with Accept
  current change, Accept incoming change and Accept both; an accept is one
  undoable edit that saves as usual. A navigator steps between blocks, a
  Changes card accepts over the exact text it shows, and Diff view waits
  while Git lists the file as conflicted. The Resolve panel and
  `git.resolveConflict` are gone.
- **§7 Design-tab extras.** A bound field shows the variable glyph and Detach
  variable (colour and number fields); the selection header names the layer
  with its type beside it; each theme row has a ⋯ with Rename… and Delete,
  each saying why when it waits.
- **Canvas (version 373).** 22 Planned badges came off, RevProviders became a
  Reference, ChgConflicts' notices became message rows with the read-only
  view's navigator gone, the Files viewer's Save failed frame shows the row
  above the code, PropertyField shows bound names without their dashes, and
  ThemeEditor gained a Row actions section. Earlier rounds are in the
  README's status log.

## What is left

### §1 Review: 7 frames, all GitHub data the renderer doesn't have yet

| Frame | Left | Needs |
|---|---|---|
| RevChecksFailing | Re-run failed, Required badges, the Expected group | Engine and control plane: a rerun of failed jobs, and the branch-protection read of required checks |
| RevChecksPassed | Required badges | The branch-protection read |
| RevCommits | A commit's check state and its chat link | Per-commit check results, and commit-to-chat provenance |
| RevTimeline | Commit chat links and check results in the stream | The same provenance, and check events in the timeline |
| RevTimelinePosting | Your avatar beside the comment box | Renderer only: the snapshot already knows the signed-in login |
| RevEmpty | The unsupported-host and load-failure states | Their copy and actions. Decided 2026-11-05: Create PR stays in the status row above, so the no-PR state shows no actions |
| States · Review surface | The states above | As above |

Not a frame, but open with them: posting from the Changes tab (`plans.md`
§1 step 2) waits for the engine and the worker to return the comparison's
head SHA, so Changes can prove its Branch diff is the published one.

### RevProviders: a reference, not planned work

GitLab merge requests and Bitbucket pull requests are not being built now
(owner, 2026-11-05). The frame stays as the layout they would fill; the
Review tab already reads its host label and merge methods from
`ReviewProvider`, so an adapter would not change the layout.
