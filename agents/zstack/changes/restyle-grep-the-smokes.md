# Restyling a shared selector: grep the smokes for it

**Symptom.** Moving the Files editor's `.cm-line` left padding to 4px, so
turning Diff view on or off moves no text, failed the composer smoke's File
Edit check in `core-inline` (`diff-files`), which pinned CodeMirror's default
6px. The scenarios run for the change (Design, Changes, the Files editor, text
selection) never mounted that fixture.

**Cause.** The check used the default padding as its stand-in for "no
`padding-left: Nch` hack", and choosing scenarios by area missed a smoke in
another area that measures the same selector.

**Rule.** Before pushing a change to a shared selector's computed style, grep
`scripts/ui-smoke*.mjs` and `scripts/ui-smoke/` for the selector and run every
scenario that measures it. Where a check pins a default as a stand-in, compare
against the invariant instead (here: an indented line keeps an unindented
line's padding), and prove it with a mutation that brings back the old bug.

**A size change moves fixtures too.** Raising the chat's reading size pushed
the tool-spacing fixture past the 900px fold, and its hover check,
`page.mouse.move` at the row's `boundingBox`, hovered nothing: the mouse never
scrolls. Scroll the row into view first (`scrollIntoViewIfNeeded`).

**Encoded in.** `core-inline`'s check now compares the indented line with the
unindented one; it fails with the old hack restored. `expectRowShape` in
`ui-smoke-tool-presentation.mjs` scrolls each row into view before hovering.
Target: `playbooks/ui-design.md` step 6, beside `primitive-change-reach`.
