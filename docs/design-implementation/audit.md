# Canvas audit: Zeros Design against the app

Status 2026-11-06, Zeros Design canvas version 381.

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
| Review tab | 26 | 0 | RevProviders is a Reference |
| Design tab | 28 | 0 | — |
| Terminal | 19 | 0 | — |
| Browser | 16 | 0 | — |
| Simulators | 12 | 0 | — |
| Customize | 25 | 0 | — |
| Settings | 36 | 0 | — |
| **Total** | **454** | **0** | |

## Landed this round

- **Checks.** Required badges from the base branch's protection and rules, an
  Expected group for required checks that haven't reported, and Re-run
  failed for the head's failed Actions runs, refused once the head moves.
- **Commits and Activity.** Each commit's combined check result, and a link
  to the chat whose turn made it: turns record the commits their own tools
  made (engine migration v45, the worker's turn record). Activity names that
  chat and adds the head's check failures with View checks.
- **Your GitHub account.** The comment box and a GitHub thread's reply row
  show the account the comment posts as.
- **RevEmpty.** Another host's state names the host and opens its page; a
  failed first read keeps the known header rows above the banner's Retry.
- **Writes that refuse.** A Changes conflict card's save refuses a file that
  changed since the card showed it, on all three write paths; a refused
  Design colour write puts the canvas preview back.
- **Canvas (version 381).** The last 7 Planned badges came off, and
  RevEmpty's load-failed state shows the banner with Retry over the tab's
  one-line fallback, as the code does. Earlier rounds are in the README's
  status log.

## What is left

No frame is planned. Not a frame, but still open: posting from the Changes
tab (`plans.md` §1 step 2) waits for the engine and the worker to return the
comparison's head SHA, so Changes can prove its Branch diff is the published
one.

### RevProviders: a reference, not planned work

GitLab merge requests and Bitbucket pull requests are not being built now
(owner, 2026-11-05). The frame stays as the layout they would fill; the
Review tab already reads its host label and merge methods from
`ReviewProvider`, so an adapter would not change the layout.
