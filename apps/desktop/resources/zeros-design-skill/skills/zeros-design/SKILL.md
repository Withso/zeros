---
name: zeros-design
description: Author, verify and implement from Zeros Design directories — the registered folders of HTML/CSS frames that the Zeros Design tab renders on its canvas. Use for any task that creates or edits Design frames, pages, tokens, themes, style sources, components or assets, verifies a frame, or implements application code from a frame.
license: MIT
compatibility: Zeros desktop on macOS, in Local Personal and organization-owned local workspaces. Cloud v2 does not expose Design.
---

# Zeros Design

A Zeros Design directory is a folder of static HTML/CSS mockups ("frames") committed with the repository. The Design tab renders the frames on a canvas, and people and agents edit the same files. There is no separate copy, export or publish step: saving a file updates the canvas.

This file is the core contract. The reference pages beside it, under `reference/`, hold the details; the table below names the one to read first for each task. The directory's own `rules.md` adds project-specific guidance; read it too.

## Know your context

Zeros injects the facts for the current conversation. Read them before acting:

- **Composer mode.** `Design` means the user wants Design source edited by default. `Code` means an attached frame is a reference for implementing application code; edit Design source only when the user asks.
- **Active Design directory** (path relative to the workspace) and its registration ID.
- **Pages** (`id`, `title`, `folder`) and the page the user is viewing. Add new frames to that page unless the user says otherwise.
- **Native verification command** and a URL for `design list|styles|validate|capture|preview` (see `reference/verify.md`).
- **Authoring method.** Local Personal and organization-owned local workspaces use the normal Read/Write/Edit/patch/shell tools. Cloud v2 has no Design authoring, preview or capture; do not route a cloud request to a Local workspace.

Provider permissions and Plan mode still apply. Saving never stages or commits; Git is a separate, explicit action.

## Workflow

1. **Read** the directory's `rules.md`, `meta/canvas.json` (pages, frames, themes, style sources) and the frames the request names. Re-read a file right before you edit it.
2. **Write** ordinary HTML and CSS with your normal tools: classes, the application's utilities and tokens (`var(--…)`), `@keyframes` and transitions. Save sources before the `meta/canvas.json` records that reference them.
3. **Register** each new frame in `frames` and in exactly one page's `frames` array.
4. **Verify** with the native command from your context, in proportion to the change.
5. **Report** what you made, what you assumed, and anything you did not verify.

## Which page to read first

| Task | Read first | Then |
| --- | --- | --- |
| Create or edit frames, pages, components or assets | [`reference/format.md`](reference/format.md) | [`reference/craft.md`](reference/craft.md) |
| Recreate a reference image or an existing design | [`reference/craft.md`](reference/craft.md) | [`reference/verify.md`](reference/verify.md) |
| Tokens, themes, fonts, style sources, or syncing the application's styles | [`reference/styling.md`](reference/styling.md) | [`reference/verify.md`](reference/verify.md) |
| Show every state or variant of a component or screen | [`reference/states.md`](reference/states.md) | [`reference/format.md`](reference/format.md) |
| Read a frame a person has edited, or predict how markup appears in the inspector | [`reference/editor.md`](reference/editor.md) | [`reference/styling.md`](reference/styling.md) |
| Check one frame or many generated frames | [`reference/verify.md`](reference/verify.md) | |
| Implement application code from a frame | [`reference/implement.md`](reference/implement.md) | [`reference/styling.md`](reference/styling.md) |

## At a glance

- Frames render HTML and CSS (classes, custom properties, `@keyframes`, transitions), inline SVG, and raster images and fonts from the Design directory or a style source. Scripts, inline event handlers, JSX/TSX, iframes and network requests do not run. The full table is in `reference/format.md`.
- A directory holds up to 64 pages and 256 frames; 12 frames stay live on the canvas and the rest show a still image (`reference/format.md`, Limits).
- Inspector edits land in the same files, mostly as declarations in the edited element's `style` attribute (`reference/editor.md`).

## Git, conflicts and concurrency

- Code and Design share one checkout, branch and index. Commit Design files with the code they belong to when the user asks for a commit.
- A Git conflict pauses the canvas until the source is resolved; repair files with normal tools and keep every ID.
- Another person or agent may be editing. Re-read before each edit, change only what the task needs, and never overwrite concurrent work.
