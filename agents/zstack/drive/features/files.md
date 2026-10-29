# Files and editor saves

**What it is.** Files combines the workspace tree, retained file tabs, source
and diff editors, and explicit or automatic saves through the active runtime.

**Reach.** Select the owner/workspace, open Files and a disposable text file.
**File options** contains **Auto save**, **Diff view**, **Save file** and
**Discard changes**. Saving changes the workspace file; it does not commit it.

**Drive.** With Auto save on, prepend a unique line and wait for the saved state.
Turn Auto save off, edit again and observe **Unsaved changes**. Switch tabs and
return; the draft must remain. Save with Cmd+S on macOS or Ctrl+S on Linux and
read the file through the same runtime to prove persistence. Use Discard only
for the disposable edit you created.

**Linux fixture.** Open `harness-file-editor.html?owner=personal&reset`; wait for
`.cm-content[contenteditable=true]:visible`. Repeat in fresh contexts with
`owner=organization` and `owner=cloud`. Prepend `// zstack-drive\n`; await that
prefix in `window.__fileEditor.disk()` and no **Unsaved changes** indicator.
Toggle Auto save off, prepend a draft, assert the indicator, save and assert the
new backing value. The backing “disk” is in-memory fixture I/O. The full driver
is `scripts/ui-smoke-file-editor.mjs`, called through file-pill navigation and
tool presentation by `codex-transcript`; `--list` lists that enclosing scenario.

**Observable end state.** Editor text and the exact owner's persisted file
match after Save, the dirty indicator clears, and another workspace's file is
unchanged. Capture the saved editor and retain the readback assertion separately.

**Gotchas.** Cloud identifiers must stay cloud keys across reads and writes.
A confirmed old save cannot clear newer typing. A retained hidden tab must not
autosave another owner's draft. Plain folders have no Git base; a diff view is
not a second authored copy. Fixture backing values do not prove filesystem or
cloud-worker writes; those require the native/live follow-up.

Sources: `apps/desktop/src/renderer/shell/workbench/tabs/files-tab.tsx`,
`apps/desktop/src/renderer/harnesses/harness-file-editor.tsx`.
