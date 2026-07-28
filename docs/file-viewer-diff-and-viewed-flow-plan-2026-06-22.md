# Row-1 Diff Viewer + Changes "Viewed" Review Flow — Research, Audit & Plan (2026-06-22)

> **Scope of this doc.** The file-by-file *diff viewing + review* experience the user specified on 2026-06-22:
> 1. Clicking a change opens the file **in row 1** with a **Diff / Preview / Edit** (markdown) or **Diff / Edit** (code) toggle.
> 2. The **Diff** toggle appears **only when the file has changes** — including newly-created files.
> 3. A **header toolbar**: `Viewed` checkbox · `Discard` · `unified ⇄ split` toggle · (later: hide-whitespace) · copy.
> 4. A **"Viewed" review flow**: mark viewed → the row **dims** in Changes → the file **auto-advances** to the next change → sweep top-to-bottom until done.
>
> This **extends and supersedes** the earlier plan in [`source-tab-changes-review-audit-2026-06-19.md` §13](./source-tab-changes-review-audit-2026-06-19.md) (Change 1 / 1b). The two-phase **Review (PR) redesign** (§13.4–13.5) is **out of scope here** — see §9.
>
> Status legend: ✅ exists · 🟡 partial · 🔴 broken · ⬜ not implemented.
>
> **The headline finding:** ~70% of the machinery already exists. `useOpenFileInRow1()` already implements the exact "navigate-to-open-tab, else reuse the one preview tab" behavior the user calls "our logic before"; the markdown Preview/Code toggle exists; `zerosDiffOptions()` already supports `split`; every changed file already carries a per-file unified `patch`; `@pierre/diffs` is already a themed dependency; live-refresh + discard already work. The genuinely new work is **(a)** a Diff branch in the file viewer, **(b)** the header toolbar, and **(c)** the **Viewed state machine** (the part the user asked me to "think deeper" about).

---

## 1. What the user asked for (decoded from the message + 10 screenshots)

| # | Requirement | Screenshot |
|---|---|---|
| R1 | **Markdown / previewable files** → a 3-way toggle **`Diff · Preview · Edit`**. "Edit" is the **renamed** current "Code" tab (read-only source for now; real editing is a later feature). | `BdUfUE`, `qLSnD3` |
| R2 | **Code / other files** → a 2-way toggle **`Diff · Edit`** (no Preview). | `BglePU`, `9vvBWB` |
| R3 | The **Diff** option is **visible only when the file has changes** in this worktree — **including newly-created files** (shown as an all-additions diff). | `qLSnD3` (new `.md`, green `+` gutter) |
| R4 | **Header toolbar** (right side of the file header): `☐ Viewed` · `↩ Discard` · `☰ unified` · `▥ split` · `¶ whitespace (later)` · `⧉ copy` · then the mode toggle. | `yvK6hK`, `7AzKn4`, `R4Oamm` |
| R5 | A **unified ⇄ split** view toggle (later: "hide whitespace changes"). | `7AzKn4` (unified) vs `R4Oamm` (split) |
| R6 | Clicking a change **opens it in row 1**. If that file is **already open** in a row-1 tab → **navigate to it**; otherwise **reuse the same (preview) tab** — *not* a new tab. "This was our logic before." | `epSSmb` (Changes list) |
| R7 | Click **`Viewed`** → the row **dims** in the Changes list. | `vzvY1R` (dimmed rows), `YowAx0` (checkbox) |
| R8 | Click **`Viewed`** → the file **auto-closes** and the **next change** opens (sweep top-to-bottom). Finish all → unchecking `Viewed` on the last one keeps you on the same file (nothing left to advance to). "Think deeper about these logics." | (described) |

**Deliverable for this turn:** research + audit + this plan. **No implementation yet** — the user wants to review the plan first.

---

## 2. Research — the diff package (`@pierre/diffs` / diffs.com)

**What it is.** `@pierre/diffs` is the open-source (Apache-2.0) diff & code-rendering library built by **The Pierre Computer Company** (`pierre.computer`, formerly `pierre.co` — "the joyful git client"). Its docs live at **diffs.com**. This is the *same* library Conductor.build uses, and the *same* one Zeros already ships for the chat EditCard and the Review tab. So "we are going to use diffs.com" = **lean harder on a dependency we already have**, not adopt something new.

- npm: `@pierre/diffs` · docs: `diffs.com` + `diffs.com/docs` · deep-dive: `pierre.computer/writing/on-rendering-diffs`
- **Version:** installed **1.2.5** (`package.json:85`); latest published **1.2.11**. A bump is low-risk (same API family) and worth doing before building on it. Also present: `@pierre/trees` `1.0.0-beta.4` (the file-icon sprite/resolver we already reuse).
- **ESM-only**, React is a **peer dep** (`^18.3.1 || ^19.0.0` — we're on 18.3.1). Import surface we use: `@pierre/diffs/react`. Internals: `shiki` (highlighting), `diff` (jsdiff — so it can compute diffs from raw strings), web-worker exports for off-main-thread highlighting.

**Exported React components** (from `dist/react/index.d.ts`):

| Component | Use here? | Notes |
|---|---|---|
| **`PatchDiff`** | ✅ already used | Renders a **unified-diff patch string**. What EditCard + Review use today. Simplest fit for row 1. |
| **`CodeView`** | candidate | **Virtualization-first** "one big scroll region of files and/or diffs," controlled + uncontrolled, with an imperative `CodeViewHandle` (programmatic scroll-to-line/range/file). Best for *large* diffs and for **driving auto-advance** (scroll targets). |
| `FileDiff` | maybe | A single file's diff from **raw old/new `FileContents`** (no patch needed) — handy for new/synthetic files. |
| `File` | maybe | A single non-diff file (syntax-highlighted) or an all-additions view of a new file. |
| `MultiFileDiff` | no | Many files at once — we render one file in row 1. |
| `UnresolvedFile` | later | Merge-conflict resolver (ours/theirs/both). |
| `Virtualizer` | with CodeView | Scroll-virtualization context. |

**Input formats.** Accepts **both** a **unified patch string** (`PatchDiff`) *and* **raw old/new file contents** (`FileContents` → it diffs internally via jsdiff). Docs: it diffs "any two files," so **new/deleted files are first-class** (empty old side → all-additions; this is exactly screenshot `qLSnD3`).

**View modes & styling (all built-in, no custom work):**
- **`diffStyle: 'unified' | 'split'`** — the split/unified toggle (R5) is *nearly free*; `zerosDiffOptions()` already plumbs it (`diff-theme.ts:55-69`).
- Diff indicators: classic `+/–`, full-width backgrounds, or vertical bars; **intra-line** word/char highlighting (`lineDiffType`).
- `expandUnchanged` / `collapsedContextThreshold` (expand context), line wrapping, line-number toggle, sticky header, `maxLineDiffLength` (large-diff guard knob).
- **Theming:** renders inside a **Shadow DOM** that bundles CSS + Shiki theme + an SVG icon atlas (isolated from app CSS). Zeros bridges tokens via **inherited CSS variables** (`var(--diff-add)`, `var(--diff-remove)`) + an injected `unsafeCSS` string — **no CSS import needed**. Theme names `pierre-dark` / `pierre-light`.
- **Annotations framework** (`lineAnnotations` / `renderAnnotation`) + **line selection/events** — the hooks for inline comments later (not needed now).

**Scale.** "On Rendering Diffs" demonstrates **700 MB+** patches and the Linux v6→v7 kernel diff via custom virtualization (keeps native scroll), binary-search line lookup, DOM pooling, and **Shiki on web workers**. Caveat for us: we currently pass **`disableWorkerPool`** and wrap `PatchDiff` with no virtualization (fine for small EditCards). For a **full-height row-1 file** that could be large/minified, we want either a **large-diff guard** or to move to **`CodeView` + workers** (§5.3, §8).

**Critical boundary — what the library does NOT do:** `@pierre/diffs` is a **renderer**, not a review-state manager. **"Viewed", auto-advance, dim, discard, and auto-unmark-on-change are entirely our responsibility** (§5.6). `CodeView`'s scroll targets / `CodeViewHandle` help *drive* advancing, but the state is ours.

---

## 3. Research — diff-review UX patterns (what "great" looks like)

Synthesized from GitHub Docs, the VS Code "GitHub Pull Requests" extension changelog, CodeRabbit, Graphite, Zed, and matklad's "Unified vs Split". The patterns we should copy:

- **GitHub "Viewed" checkbox** (the canonical model): marking a file viewed **collapses + dims** it, advances an **"X of Y viewed"** progress count, and **persists per-reviewer**. **Most important behavior to copy:** *"If the file changes after you view it, it is **unmarked** as viewed."* For our **live agent-edit** workflow this is essential — a viewed file that the agent re-edits must **re-surface as unviewed**. GitHub web does **not** auto-advance and has **no native next-file shortcut** (`v` toggles viewed, `w` toggles whitespace).
- **VS Code PR extension = the auto-advance gold standard** (and the closest match to the user's R8): *"When 'Mark File as Viewed' is run… the file will also be **closed**,"* and combined with the open diff list the **next diff is already underneath** → effective auto-advance. It also ships **"Go to Next Diff in PR"** and **"Reset Viewed Files."** → This is precisely "the file auto-closes and the next change opens."
- **CodeRabbit**: keyboard-first (`J`/`K` next/prev), orders files into logical **"change cohorts"** rather than alphabetical, and **syncs viewed-state to/from GitHub**. Takeaway: deterministic review order + keyboard nav are worth it.
- **Unified vs Split** (Zed / matklad): **no universal winner — ship both and persist the choice.** Unified = compact, narrow screens, line-by-line; split = big rewrites, structural understanding, wide screens. GitHub persists **unified/split *globally*** but **whitespace *per-review*** — a good rule to mirror.
- **Large diffs**: collapse big/generated files by default; virtualize; offer a "load diff / open file" affordance for huge files.
- **Discard/revert** is an editor concept (VS Code per-file/per-hunk "Discard Changes", always confirmed), **distinct from Viewed**. We already have a confirmed per-file discard — keep it separate from the Viewed flow.

**Design rules we adopt:**
1. Mark-viewed → **dim + close + auto-advance to the next *unviewed* change** (directional sweep, §5.6 / D3).
2. **Auto-unmark-on-change** (GitHub model) — load-bearing because agents edit live.
3. **Persist unified/split globally**; whitespace per-workspace (later).
4. Keep **Discard** separate, per-file, confirmed (already true).
5. Add **keyboard affordances** (`v` = toggle viewed, `j/k` = next/prev) — cheap, high value.
6. **No "N of M viewed" count badge** (D8 — the user explicitly does not want a progress count). The dim state on the list *is* the progress signal.

---

## 4. Current-state audit (EXISTS vs MISSING)

Grounded in the current `montpellier` tree (three parallel code audits + the §13 audit doc).

### 4.1 The foundation that ALREADY exists ✅

| Capability | Where | Note |
|---|---|---|
| **"Navigate-to-open-tab, else reuse the one preview tab"** (R6) | `src/shell/use-open-file-in-row1.ts:38-75` | **This is exactly "our logic before."** `useOpenFileInRow1(path)`: find a `files` tab with that `filePath` → `ACTIVATE`; else find the `preview` tab → `UPDATE_COLUMN3_TAB{filePath,title}` + `ACTIVATE`; else `ADD` a new preview tab. **Already used by All Files** (`AllFilesView`). Changes rows just don't call it yet. |
| Single reusable **preview tab** per worktree | `Column3Tab.preview` flag, `column3-tab-manager.ts:25-94` | Persisted per worktree (`column3-tabs-by-scope-v1`). |
| Row-1 file viewer (text/markdown/image/binary/too-large) | `src/shell/column3-tabs/file-viewer.tsx:80-209` | Shiki `HighlightedCode`, line gutter, image preview, placeholders. |
| **Markdown `Preview \| Code` toggle** | `file-viewer.tsx:82, 132-150` | The pill we **rename to `Edit`** and **extend with `Diff`** (R1). |
| `@pierre/diffs` `<PatchDiff>` themed for Zeros | `review-tab.tsx`, `tool-edit.tsx`, `src/zeros/appearance/diff-theme.ts` | `zerosDiffOptions({ diffStyle, disableFileHeader })` — **`split` already supported** (R5). |
| **Per-file unified `patch`** on every changed file | `ChangedFile.patch`, `changes-parse.ts:12-35` | Already parsed; the diff pane that consumed it was removed. |
| Git façade for single-file diff | `src/native/git.ts` `gitDiff({ workspaceId, filePath, mode, rawPatch })` | Modes incl. `worktree-vs-head`, `worktree-vs-base`, `refs`. New/deleted/rename handled in parse. |
| **Live refresh** (agent/terminal git activity) | `engine/git/watch.ts` (3 s `.git` stat-poll) → `DB_CHANGED{workspaces}` → `refreshKey` bump | Already shipped (§13 #3). The Viewed-store will subscribe to the same signal for auto-unmark. |
| **Per-file Discard** (confirmed) | `runDiscard` + `DiscardDialog`, `changes-tab.tsx`; `gitDiscard`/`gitClean`/`gitUnstage` | We surface this in the header (R4) — logic already exists. |
| Changes list (flat + tree, scope: uncommitted / all-vs-base / commit) | `changes-tab.tsx` `ChangesView` | Rows currently only set local `selected` highlight. |

### 4.2 What's MISSING / must be built ⬜

| Gap | Where it lands | Maps to |
|---|---|---|
| Changes-row click does **not** open row 1 (only highlights) | `changes-tab.tsx` `FileRow.onClick` → call `useOpenFileInRow1` w/ diff intent | R6 |
| Row-1 viewer has **no Diff mode** (content-only) | `file-viewer.tsx` — add a Diff branch rendering `<PatchDiff>` | R1, R2 |
| **Diff/Preview/Edit toggle** (rename `Code`→`Edit`; add `Diff`) | `file-viewer.tsx:132-150` | R1, R2 |
| **"Show Diff only when changed"** detection | viewer fetches per-file `gitDiff`; empty ⇒ hide Diff | R3 |
| **Header toolbar** (Viewed / Discard / unified-split / whitespace-later) | `file-viewer.tsx` header | R4, R5 |
| **unified⇄split toggle wired** (capability exists, no UI) | pass `diffStyle` to `zerosDiffOptions`; persist globally | R5 |
| **`diff?` / `diffBase?` intent on the tab** | `column3-tab-manager.ts` `Column3Tab` + `createFilesTab` | R6 |
| **`workspaceId` threaded to the viewer** | `files-tab.tsx` (has only `cwd`) → resolve from `useActiveWorkspace()` | R1 |
| **Viewed state** (persisted, per-file) + **dim** in Changes | new small store/hook (localStorage per workspace) | R7 |
| **Auto-advance** on mark-viewed + **auto-unmark-on-change** | the Viewed state machine (§5.6) | R8 |
| Tracked-binary raw-text leak / image-in-diff / large-diff guard | carry over §4.3–4.5 of the audit doc into the row-1 viewer | (quality) |

---

## 5. The plan — feature spec

### 5.1 Toggle model (R1, R2)

The mode toggle is a function of **file kind** × **has-changes**:

| File kind | No changes | Has changes |
|---|---|---|
| **Markdown** (`.md/.markdown/.mdx`) | `Preview · Edit` (today's `Preview · Code`, **renamed**) | **`Diff · Preview · Edit`** |
| **Other text/code** | *(no toggle — just the source view + copy, as today)* | **`Diff · Edit`** |
| **Image** | image preview (as today) | image preview *(image-diff is later)* |
| **Binary / too-large** | placeholder (as today) | placeholder |

- **"Edit" = the read-only source view (renamed "Code") for now.** Real editing is a **later** feature; the label ships now, the behavior is unchanged (read-only, Shiki-highlighted). **Decided (D1):** "Edit" — all files become editable in the future.
- **Default mode follows the entry point (D2):** opening from **Changes → Diff**; opening from **All Files → Edit** (markdown defaults to Preview/Edit per kind, never Diff). **This applies even when navigating to an already-open tab:** re-clicking `tsup.config.ts` from All Files *while it's open in Diff* **switches it to Edit** in place, and re-clicking it from Changes switches it back to Diff. (The user can still toggle manually once it's open.) → `useOpenFileInRow1` must **update the tab's `diff` field on the navigate-to-existing path**, not just `ACTIVATE` (§5.5).

### 5.2 "Diff only when changes exist," incl. new files (R3)

The viewer must decide *show Diff?* regardless of entry point (the user wants Diff to appear for "all files… when there have been changes," even from All Files).

**Mechanism (self-contained, per-file, cheap):** when a file opens, the viewer fetches its **single-file diff** for the active scope:
- `gitDiff({ workspaceId, filePath, mode, rawPatch:true })` → if the returned patch is **non-empty**, the file has changes → **show `Diff`**; if **empty**, hide `Diff`.
- **Untracked / brand-new** files won't appear in `git diff`; reuse the existing `syntheticAddPatch(path, content)` + `readWorkspaceFile` path (moves from `changes-tab.tsx` to the viewer) → an all-additions patch (screenshot `qLSnD3`). Non-empty ⇒ show `Diff`.
- **Scope:** mirror the Changes tab's scope. `worktree-vs-head` (uncommitted) is the simplest default; carry `diffBase` on the tab for the "All changes vs base" case (`refs`, `base=diffBase, head=HEAD`). Opening from Changes passes the current scope; All Files defaults to "uncommitted vs HEAD" (or the workspace's branch-vs-base — **decision D2 below**).

This naturally handles new/modified/deleted/renamed; binary/image get the placeholder/preview branch (no textual Diff).

### 5.3 The row-1 Diff renderer (R1) — `file-viewer.tsx`

1. Thread **`workspaceId`** into the viewer (resolve live from `useActiveWorkspace().workspace.id`; don't persist a stale id — §13.3).
2. When mode = **Diff**: render `<PatchDiff patch={patch} options={zerosDiffOptions({ diffStyle })} />` fed by the patch from §5.2.
3. **Carry over the known diff-rendering defects** as row-1 requirements (they relocate from the old pane, they don't vanish):
   - **Tracked-binary leak** (audit §4.3): check `binary` *before* rendering the patch → show a placeholder, not raw `Binary files … differ` text.
   - **Image change** (§4.5): reuse the viewer's existing image branch (before/after image-diff is later).
   - **Large/minified diff guard** (§4.4): cap section size (truncate + "open file" affordance), **or** adopt `CodeView` + worker pool for virtualized rendering. *Recommendation:* start with `PatchDiff` + a guard (consistent with existing code); evaluate `CodeView` if large diffs feel slow (§8).
4. **`disableWorkerPool`:** keep for small diffs; reconsider for the full-height viewer (large files benefit from workers).

### 5.4 The header toolbar (R4, R5) — order matches `yvK6hK`

Right side of the file header, left→right:

```
[☐ Viewed]  [↩ Discard]  [☰ unified | ▥ split]  [¶ whitespace*]  [⧉ copy]   ‖   [ Diff · Preview · Edit ]
```

- **`Viewed` checkbox** — visible whenever the file **has changes**; toggles the Viewed store (§5.6). Drives the dim in Changes.
- **`Discard` (↩)** — visible when the file has changes **and** the workspace is writable (hidden on the read-only trunk). Reuses the existing confirmed `runDiscard`/`DiscardDialog` flow. After discard the file has no changes → leaves Changes → advance like a viewed file (D4).
- **`unified ⇄ split`** (`☰`/`▥`) — visible **only in Diff mode**; sets `diffStyle`, **persisted globally** (GitHub rule). Capability already in `zerosDiffOptions`.
- **`¶ whitespace`** — *later* ("hide whitespace changes"); reserve the slot. (`@pierre/diffs` supports it; engine `-U3` is fixed today.)
- **`⧉ copy`** — exists; keep.
- The **mode toggle** (`Diff/Preview/Edit`) sits at the far right (§5.1).

Show the file path as a **rounded pill** to match `yvK6hK` (minor restyle of `PathBreadcrumbs`).

### 5.5 Changes → row-1 navigation (R6) — *mostly already built*

Re-point `FileRow.onClick` from "set local `selected`" to **`useOpenFileInRow1(path, { diff:true })`**:
- This **is** the requested behavior — `useOpenFileInRow1` already does "focus the tab if the file is open, else reuse the single preview tab, never spawn a new tab."
- **Extend the hook to carry a desired mode (D2):** today the navigate-to-existing branch only `ACTIVATE`s. It must also `UPDATE_COLUMN3_TAB { diff }` so re-opening the same file from a different source **switches its mode** (Changes→Diff, All Files→Edit) even when the tab is already open. Pass `{ diff:true, diffBase? }` from Changes and `{ diff:false }` from All Files.
- Keep a lightweight `selected` path only to **highlight** which row is open (no longer needed to disambiguate a pane).
- `ChangesView` needs `useColumn3Tabs()` + `useWorkspaceDispatch()` (or lift `openInRow1` to a shared helper used by both All Files and Changes — recommended, removes duplication).

### 5.6 The "Viewed" review flow — the state machine (R7, R8) ⭐

This is the part to get right. Definitions:

- **Viewed store** (new): persisted per workspace, `viewedByFolder: Record<folderPath, Record<filePath, { hash: string }>>` in localStorage (mirrors `column3-tabs-by-scope-v1` / `changes-scope` patterns). `hash` = a cheap hash (e.g. FNV/djb2) of the file's **"All"-scope diff** (`worktree-vs-base` — the file's full branch contribution). **Decided (D5):** key on the folder/worktree only, **not** by uncommitted-vs-all; track against the "All" diff so *any* new change (committed or uncommitted) changes the hash and re-surfaces the file.
- **A file is "viewed"** ⟺ an entry exists for it **and** `entry.hash === currentDiffHash(file)`. If the hash differs (the agent re-edited it, or the user changed it again), the entry is **stale ⇒ treated as unviewed** (auto-unmark-on-change, the GitHub rule).
- **Review order** = the Changes list order (top-to-bottom, after the existing sort), with positions indexed `1..M`.

**Transitions:**

1. **Mark viewed** (header checkbox checks, or `v`):
   1. Write `{ [filePath]: { hash } }` to the store → the Changes row **dims** immediately (it reads the same store).
   2. **Auto-advance (D3 — directional sweep).** With the current file at list index `i`, pick the next file to open:
      - a. **Nearest unviewed *below*** (scan `i+1 → M`) → go there (continue the top-to-bottom sweep). *(e.g. at #7 with #8,#9,#10 unviewed → #8 → #9 → #10.)*
      - b. Else if the **file immediately above (`i−1`) is unviewed** → go there (reverse into a bottom-to-top sweep). *(e.g. at #10 with #11–15 already viewed → walk #9 → #8 → #7…)*
      - c. Else (both directions blocked) → **restart from the topmost unviewed file (#1) and sweep down.** *(e.g. at #10 with #7–9 **and** #11–15 all viewed → jump to #1 → #2 → #3…)*
      - d. **No unviewed files remain** → **stay** on the current (now-dimmed) file; row 1 shows a subtle "all changes viewed" affordance. *(This is the user's "it will be in the same file because there are no files to visit.")*
      - Advancing reuses the preview tab in Diff mode — `openInRow1(next, { diff:true })` — so the current file is "closed" by being swapped out.
2. **Unmark viewed** (uncheck, or `v` again): remove the entry → row un-dims → **no auto-advance** (you stay on the file). *(User: unchecking the last one keeps you there.)*
3. **File changes under a viewed entry** (agent edits it; live-refresh fires): `currentDiffHash` changes → entry goes stale → the row **re-surfaces (un-dims)** and re-enters the unviewed set. No user action needed.
4. **Discard** a file (§5.4): file leaves the Changes set → drop any viewed entry → auto-advance to next change (treat like "resolved").
5. **All files become viewed**: the Changes list is fully dimmed; row 1 shows the last file with an "All viewed ✓" affordance. Unchecking any row brings it back as the sole unviewed (and you're already on it, per #2).

**Edge cases to honor:**
- Marking viewed from the **header** and the **Changes list** must read/write the **same store** (single source of truth) so dim + checkbox stay in sync.
- **Per-scope:** viewed-state is scoped to the *folder* (worktree). Switching scope (uncommitted ↔ all) may change the file set and the per-file patch → hashes differ → entries naturally re-evaluate. (Decision D5: whether to also key the store by scope.)
- **Don't lose state on refresh:** persisted in localStorage; survives remounts and the live `refreshKey` bumps.
- **Keyboard:** `v` toggle viewed, `j`/`k` next/prev change (open in row 1). Cheap; matches CodeRabbit/VS Code.

**Why hashing the patch (not just the path):** it's the only way to deliver auto-unmark-on-change, which is *the* behavior that makes "Viewed" trustworthy while an agent edits files live. Without it, a file you reviewed and the agent then rewrote would stay dimmed and you'd miss the new changes.

---

## 6. Visibility matrix (single source of truth for the UI)

| Element | Shown when | Default / persistence |
|---|---|---|
| `Diff` tab | file has changes (non-empty patch) or is untracked-new | default mode if opened via diff intent |
| `Preview` tab | markdown only | default for markdown opened w/o diff intent |
| `Edit` tab | always (text files) | renamed "Code"; read-only for now |
| `Viewed` checkbox | file has changes | per-file, persisted, hash-keyed |
| `Discard` (↩) | file has changes **and** writable (not trunk) | confirmed action |
| `unified/split` | **Diff mode only** | global preference |
| `whitespace ¶` | Diff mode only — **later** | per-workspace (later) |
| `copy ⧉` | text files | — |

---

## 7. Implementation plan (step-by-step, non-destructive)

Extends §13.7 Steps 1–2; adds the toolbar + Viewed flow.

| Step | What | Layer | Effort | Files |
|---|---|---|---|---|
| **1** | Lift `openInRow1` to a shared helper; re-point **Changes `FileRow.onClick`** → open in row 1 with `diff:true` (+`diffBase`). Keep `selected` as highlight only. | 🎨 | S | `use-open-file-in-row1.ts`, `changes-tab.tsx` |
| **2** | Add **`diff?` / `diffBase?`** to `Column3Tab` + `createFilesTab`; thread **`workspaceId`** into the viewer (`files-tab.tsx` → `useActiveWorkspace`). | 🎨 | S | `column3-tab-manager.ts`, `files-tab.tsx` |
| **3** | **Row-1 Diff branch**: per-file `gitDiff` fetch (+ synthetic-add for untracked) → `<PatchDiff>`; binary/image/large-diff handling; "show Diff only if non-empty." | 🎨 | M | `file-viewer.tsx` |
| **4** | **Mode toggle**: rename `Code`→`Edit`; add `Diff` (md: `Diff·Preview·Edit`; code: `Diff·Edit`); default-mode logic. | 🎨 | S | `file-viewer.tsx` |
| **5** | **Header toolbar**: `unified/split` (wire `diffStyle`, persist global); `Discard` (reuse `runDiscard`); `copy` (exists); path pill; reserve whitespace slot. | 🎨 | S–M | `file-viewer.tsx`, small shared discard helper |
| **6** | **Viewed store + hook** (localStorage, hash-keyed on the "All" diff); `Viewed` checkbox in header; **dim** Changes rows from the same store. No count badge (D8). | 🎨 | M | new `use-viewed-files.ts`, `changes-tab.tsx`, `file-viewer.tsx` |
| **7** | **Auto-advance (D3 directional sweep) + auto-unmark**: next-unviewed traversal on mark-viewed; re-surface on diff-hash change (subscribe to the existing `refreshKey`/`DB_CHANGED`); discard→advance (D4). | 🎨 | M | `use-viewed-files.ts`, `changes-tab.tsx`, `file-viewer.tsx` |
| **8** | **Keyboard**: `v` toggle viewed, `j/k` next/prev change. | 🎨 | S | viewer/changes key handlers |
| **9** | (Optional) Bump `@pierre/diffs` 1.2.5 → 1.2.11; evaluate `CodeView` for large diffs. | ⚙️🎨 | S–M | `package.json`, `file-viewer.tsx` |

**Sequencing:** ship **1–3** first (the click lands somewhere real — a diff in row 1), then **4–5** (toggle + toolbar), then **6–7** (the Viewed flow — the highest-design-risk part), then **8–9** (polish). Each step is independently shippable; nothing old is retired until its replacement works. **All 🎨** except the optional version bump — no new engine/bridge ops are required (the per-file `gitDiff`, discard, and live-refresh all already exist).

**Test coverage to add:** Viewed store (mark/unmark/stale-hash → unview), next-unviewed traversal (incl. none-left), "Diff visible iff non-empty patch / untracked-new", binary-not-leaked, split/unified persistence. The repo already stubs `navigator` for `@pierre/diffs` under vitest (`vitest.setup.ts`).

---

## 8. Design decisions — RESOLVED 2026-06-22 (one open: D6)

| # | Decision | Resolution |
|---|---|---|
| **D1** | "Edit" vs "Source" label. | ✅ **"Edit"** — all files become editable later; label ships now (read-only). |
| **D2** | Default mode by entry point + switching. | ✅ **Changes → Diff; All Files → Edit.** Re-clicking the same file from the other source **switches its mode in place** (must update the tab's `diff` on navigate-to-existing, not just activate). |
| **D3** | Auto-advance order. | ✅ **Directional sweep** (§5.6): nearest unviewed **below** → else **immediate-above if unviewed** → else **restart from the topmost unviewed**. |
| **D4** | Discard → auto-advance? | ✅ **Yes** — after the confirm, advance exactly like Viewed (D3 rule). |
| **D5** | Scope-key the Viewed store? | ✅ **No** — key by folder only; hash the **"All" (`worktree-vs-base`)** diff so any new change (committed or not) re-surfaces the file. |
| **D6** | `PatchDiff` (+ guard) vs **`CodeView`** (virtualized) for row 1. | ⏳ **OPEN** — recommend `PatchDiff` + large-diff guard first; `CodeView` only if huge diffs must render fully. Decides whether lockfiles/bundles show as a diff or as "too large — view as file." |
| **D7** | Bump `@pierre/diffs` 1.2.5 → 1.2.11? | ✅ **Yes** — bump early; smoke-test EditCard + Review after. |
| **D8** | "N of M viewed" count badge. | ✅ **Dropped** — no count badge; the dimmed rows are the progress signal. |

---

## 9. Explicitly out of scope (this plan)

- **Two-phase Review / PR redesign** (audit doc §13.4–13.5: pre-PR create form, agent-driven Create PR, post-PR rich view, `prNumber` reconciliation). Separate effort — not in the 2026-06-22 message.
- **Real editing** in the "Edit" tab (it's read-only source for now).
- **Per-hunk / per-line staging** (audit §10 #6 — deferred there too; reachable via terminal/agent).
- **Inline per-line comments / PR annotations**, **conflict-resolution UI**, **word/char intra-line diff**, **expand-context**, **"hide whitespace"** (slot reserved, behavior later).
- **Image before/after diff** (image *preview* stays; image *diff* later).

---

## 10. Risks & notes

- **`@pierre/diffs` is a renderer only** — Viewed/advance/dim/unmark are ours (§5.6). Don't expect library support.
- **Large/minified diffs** in a full-height viewer are a real freeze risk with `PatchDiff` + `disableWorkerPool` + no virtualization (audit §4.4). Guard or use `CodeView`.
- **Auto-unmark-on-change** depends on a stable per-file **diff hash** + the **live-refresh signal** (both exist) — without it, "Viewed" lies during live agent edits. Treat as core, not polish.
- **Engine main process doesn't hot-reload** — but this plan is **renderer-only** (no engine changes), so HMR applies; no app restart needed.
- **Single preview tab** means "auto-close + open next" = "swap the preview tab's content." If the user also opened files in *pinned* (non-preview) tabs, those are untouched by the sweep — the sweep only drives the preview tab. (Confirm this matches intent.)

---

### Appendix — key file references

- `src/shell/use-open-file-in-row1.ts:38-75` — the navigate-or-reuse logic (R6, already built)
- `src/shell/column3-tab-manager.ts:25-94` — `Column3Tab`, `createFilesTab`, `preview` flag (add `diff?`/`diffBase?`)
- `src/shell/column3-tabs/file-viewer.tsx:80-209` — the viewer (header `:122-155`, md toggle `:132-150`)
- `src/shell/column3-tabs/files-tab.tsx:27-29` — `<FileViewer cwd path>` (thread `workspaceId`)
- `src/shell/column3-tabs/changes-tab.tsx` — `ChangesView`, `FileRow.onClick`, `runDiscard`/`DiscardDialog`
- `src/shell/column3-tabs/changes-parse.ts:12-35` — `ChangedFile.patch` (per-file diff already parsed)
- `src/zeros/appearance/diff-theme.ts:32-80` — `zerosDiffOptions({ diffStyle, disableFileHeader })` (split ready)
- `src/native/git.ts` — `gitDiff({ workspaceId, filePath, mode, rawPatch })`, `gitDiscard`/`gitClean`
- `src/engine/git/watch.ts` — live-refresh source (subscribe for auto-unmark)
- `docs/source-tab-changes-review-audit-2026-06-19.md` §13 — the parent plan this extends
