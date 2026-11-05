# Canvas audit: Zeros Design against the app

Status 2026-11-05, Zeros Design canvas version 363.

## How to read this

Each canvas frame shows one of two things:

- **The shipped UI.** The frame has no badge.
- **A Planned badge.** It names what is left and the `plans.md` section that
  owns it.

Earlier rounds verified the unbadged frames against the code. They rendered
every state in both themes, and the ui-smoke registry measures the looks the
frames pin. This round re-checked the Review and Changes pages against their
rebuilt code, and spot-checked the Design-tab component sheets.

Counts come from the canvas: `canvas.json` and each frame's plan line. The
canvas's 91 notes are section titles. Implementation notes live in the frames
and in [`plans.md`](plans.md).

## By page

| Page | Frames | Planned | What is left |
|---|---:|---:|---|
| UI components | 47 | 6 | The Design-tab component sheets; see the deltas below |
| Foundations | 14 | 0 | — |
| Branding | 4 | 0 | — |
| Web app | 60 | 56 | §8. The shared page shell shipped. Still to do: one sign-in page (2), each page's copy (32), the dashboard rebuild (18), Ops on the dashboard shell (3), and the route map (1) |
| Agent chat | 87 | 0 | — |
| Sidebar | 25 | 0 | — |
| Dashboard (Home) | 18 | 0 | — |
| Files tab | 7 | 1 | §5: gutter signs, and no wash for new files |
| Changes tab | 35 | 18 | §6 comment authors (10), §5 gutter signs (5), §4 conflicts in place (2), §3 retiring hunk review together with §5 (1) |
| Review tab | 26 | 8 | §1 leftovers, listed below |
| Design tab | 28 | 0 | — |
| Terminal | 19 | 0 | — |
| Browser | 16 | 0 | — |
| Simulators | 12 | 0 | — |
| Customize | 25 | 0 | — |
| Settings | 36 | 0 | — |
| **Total** | **459** | **89** | |

## Landed this round

- **Review Overview.**
  - The header reads in rows, under five sub-tabs.
  - Git status comes from the shared island.
  - PR status holds the one Merge and only its blockers.
  - Findings, and a rail that folds into Details below 768px.
  - A pending shell paints the PR's known identity during the first read.
- **Review sub-tabs.** Description, Activity, Checks and Commits sit in
  Overview's inset under a section header.
  - Description edits the body through `gh.prUpdate`, for Local and cloud.
  - Activity filters All, People and Bots, and folds an App's review until
    Show.
  - Checks opens on a summary card and ends with deployment cards.
  - Commits group by day, with Copy, Open and the short SHA.
  - The merge menu says what each method does to the commits.
- **Changes.** One card per file: a 12px inset and gap, a border1 edge and
  8px corners. Collapsed files no longer stack flush.
- **Canvas (version 363).**
  - Eleven Planned badges came off frames that are now built.
  - The remaining notes name exactly what is left.
  - The Changes "All states" frame had been clipping its tallest state by
    280px; it now fits.

## What is left

### §1 Review: 8 frames

| Frame | Left | Needs |
|---|---|---|
| RevChecksFailing | Re-run failed, Required badges, the Expected group | Engine and control plane: a rerun of failed jobs, and the branch-protection read of required checks |
| RevChecksPassed | Required badges | The branch-protection read |
| RevCommits | A commit's check state and its chat link | Per-commit check results, and commit-to-chat provenance |
| RevTimeline | Commit chat links and check results in the stream | The same provenance, and check events in the timeline |
| RevTimelinePosting | Your avatar beside the comment box | Renderer only: the snapshot already knows the signed-in login |
| RevEmpty | Create pull request and the branch picker inside the empty state; the unsupported-host and load-failure copy | A decision. Today the status row above Review offers Create PR, so the empty state doesn't repeat it |
| RevProviders | GitLab merge requests and Bitbucket pull requests | Provider adapters behind `ReviewProvider` |
| States · Review surface | The states above | As above |

### §3 Retire hunk review: 1 frame (ChgWindow)

This removes four things:

- the Accept and Reject rows and their payload;
- the renderer client (`platform/git-review-actions.ts`);
- the `git.reviewHunks` engine operation;
- its protocol schemas.

The registered `git-review-actions` smoke then asserts that the controls are
absent. Its registry entry in `scripts/ui-smoke/` is a CI-definition path,
so the scenario id and export stay. The protocol change needs
`check:protocol`.

### §4 Conflicts in place: 2 frames

Each conflict is marked in the editor with Accept current, incoming and both,
plus a navigator. The Resolve conflicts panel goes.

### §5 Diff rows: 6 frames (Files Diff view and Changes)

- Pierre's default bars already draw the 2px change bar.
- Still to do: the + and − signs in the number padding, no row wash for a new
  or untracked file, and the caret line's lift.
- This is CSS in Pierre's shadow DOM. Mind `shadow-host-document-cascade`: a
  `:host` rule loses to the document.

### §6 Comment authors: 10 frames

Agents get their mark, GitHub authors their photo, and review apps their logo
with a Bot badge. The thread model needs each comment's avatar URL and its
agent provider.

### §8 Web app: 56 frames

See plans.md §8: the sign-in page, page copy, the dashboard's Settings
anatomy, account pages and Ops.

### UI components: the Design-tab sheets (6 frames)

The spot check found these deltas against the code:

| Sheet | Spec | Code |
|---|---|---|
| PropertyField | Label 12 medium fg3, 24 wide | `zd-field-label w-7`, 28 wide |
| ThemeEditor | Rail rows: selected bg2-highlight | A pressed row (`aria-pressed`) fills `--bg2-hover` |
| Inspector | Panel 280, 220–640 | Matches (`design-workspace-width.ts`) |
| ThemeEditor | Rail 168, rows 28, hover bg1-hover | Matches (`design-theme-editor.css`) |

Which fill a selected row uses also bears on the `selected-bg` direction. So
the sheets stay Planned until that is decided and the remaining specs are
measured.
