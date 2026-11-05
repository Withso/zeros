# Canvas audit: Zeros Design against the app

Status 2026-11-05, Zeros Design canvas version 368.

## How to read this

Each canvas frame shows one of two things:

- **The shipped UI.** The frame has no badge.
- **A Planned badge.** It names what is left and the `plans.md` section that
  owns it.

Earlier rounds verified the unbadged frames against the code. They rendered
every state in both themes, and the ui-smoke registry measures the looks the
frames pin. This round re-checked the Review and Changes pages against their
rebuilt code, and measured every spec line on the six Design-tab component
sheets in the Design harness.

Counts come from the canvas: `canvas.json` and each frame's plan line. The
canvas's 91 notes are section titles. Implementation notes live in the frames
and in [`plans.md`](plans.md).

## By page

| Page | Frames | Planned | What is left |
|---|---:|---:|---|
| UI components | 47 | 3 | Three Design-tab details, listed below |
| Foundations | 14 | 0 | — |
| Branding | 4 | 0 | — |
| Web app | 55 | 0 | — |
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
| **Total** | **454** | **30** | |

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
- **Design-tab sheets.** Each spec line on the six sheets was measured in
  the harness, and the app now follows them:
  - Fields hover in bg2-highlight. Editing shows only the caret; keyboard
    focus rings with a 3px halo. A trigger or action on a field's end is
    20px, on a 36px fade from the field's own fill.
  - Layers: owned rows on bg2, fg3 type icons and chevrons, hidden rows in
    fg3, a 20px visibility action, the count as a Badge, Collapse all at 28,
    a fg3 loading line, fg2 error and empty lines, and rename in the shared
    24px inline field.
  - Inspector: a 36px selection header, 12px glyphs on 24px section
    actions, regular-weight empty sections, segmented 8/6, pads 8, and the
    blocking reason as an error row on red-bg.
  - Popovers: 240 or 320 wide, 72px labels, controls on bg3-hover.
  - Theme editor: the chosen rail row on bg2-highlight, 12 fg3 labels and
    counts, mono 12 names, the edited theme as a pressed toggle on
    selected-bg, a 20px swatch and Reset.
- **Web app sign-in and centred pages.**
  - Sign-in offers Continue with Google and Continue with GitHub, each
    started directly (the owner's decision); Ops and step-ups keep Hosted
    AuthKit.
  - One page shell follows the canvas recipe with inline logos and tokens,
    shared verbatim with the control plane's sign-in and GitHub pages.
  - Every centred app page has its frame's copy, and the account states are
    centred pages with one primary.
- **Web dashboard and Ops.**
  - The dashboard follows its 18 frames, with one set of markup builders
    for the server's first paint and the browser's re-renders. It lists
    cloud organizations only, and recoverable organizations by name.
  - Ops follows its 7 frames: the centred states on the shared shell with
    Ops beside the logo, and the console on the dashboard layout, each page
    allowing its one inline block by nonce under the Ops policy.
- **Open in Zeros on a cloud workspace.**
  - The web workspace page reads its workspace from the cloud v2 API, as its
    creator, and offers Open in Zeros through
    `zeros[-channel]://cloud-workspace/<organization>/<workspace>`.
  - The desktop app switches to that organization and opens the workspace,
    and a cloud workspace's menu copies the page's link.
  - The invite page is gone: cloud workspaces are creator-only.
- **Loaders.** The centred pages and the dashboard draw the app's square
  Orbit. The workspace loading and GitHub checking frames had lost their
  badge without the loader they draw, and the dashboard's loader was round.
- **Canvas (versions 363 to 368).**
  - Eleven Planned badges came off frames that are now built.
  - The remaining notes name exactly what is left.
  - The Changes "All states" frame had been clipping its tallest state by
    280px; it now fits.
  - Version 364: three Design-tab sheets lose their badge and three narrow
    it, RevEmpty shows the no-PR state the app ships, and the colour picker
    sheet draws its fields on bg3-hover like the other popovers.
  - Version 366: 25 Web app frames lose their badge, and the four frames for
    code removed with Auth0 (the rollback sign-in and callback, `/launch` and
    the legacy handoff) are gone.
  - Version 367: the dashboard (18) and Ops (7) frames lose their badge and
    show what shipped: the switcher shows your role, Teams drops its member
    count, the outage keeps Profile, owners see Force purge disabled, and a
    new frame shows Ops' Identity recovery section.
  - Version 368: the workspace page's Ready frame and the route map lose
    their badge, the two workspace invitation frames are gone, and the route
    map is fitted to its rows.

## What is left

### §1 Review: 8 frames

| Frame | Left | Needs |
|---|---|---|
| RevChecksFailing | Re-run failed, Required badges, the Expected group | Engine and control plane: a rerun of failed jobs, and the branch-protection read of required checks |
| RevChecksPassed | Required badges | The branch-protection read |
| RevCommits | A commit's check state and its chat link | Per-commit check results, and commit-to-chat provenance |
| RevTimeline | Commit chat links and check results in the stream | The same provenance, and check events in the timeline |
| RevTimelinePosting | Your avatar beside the comment box | Renderer only: the snapshot already knows the signed-in login |
| RevEmpty | The unsupported-host and load-failure states | Their copy and actions. Decided 2026-11-05: Create PR stays in the status row above, so the no-PR state shows no actions |
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

### UI components: the Design-tab sheets (3 frames)

| Sheet | Left | Needs |
|---|---|---|
| PropertyField | A field bound to a variable shows the variable glyph and Detach variable | A detach operation in the style model |
| Inspector | The selection header names the layer, with its type beside it | Selection smokes read the header's text as a state signal; move them to data attributes first |
| ThemeEditor | The row actions (⋯) | Renaming and deleting a variable in the token API |

A correction to the previous round: this audit said in-field labels were 28px
wide. The visible W, H and X labels were already 24px; only InspectorSelect's
leading slot, which no caller passes, was 28px. It is now 24px too.
