# Composer file mentions

The `@` picker searches files and folders on disk, including `.context/`
attachments, other dotfiles and dotfolders, ignored dependencies/build outputs,
and empty directories. Git ignore rules do not define mention visibility.
Symlinks themselves are selectable; search does not traverse them, so cycles
and links outside the workspace cannot expand the search boundary.

The existing `git_list_files` IPC and `file.tree` bridge operation accept an
opt-in `includeIgnored: true`, `query`, and optional `mentionRevision`. Directory
paths have a trailing `/`.
Default file-tree callers retain their Git-aware behavior. Inclusive search
retains the existing local-only ignored-file boundary; relay clients cannot use
the option to enumerate private sibling worktrees inside ignored directories.

`engine/files/mention-paths.ts` shares one filesystem name index across queries
and composers for a workspace revision. New revisions rebuild it; concurrent
requests share the scan, and changes during a scan require one replacement for
the newest revision. The cache retains at most four completed indexes within a
96 MiB estimated memory budget. Construction also stops at that budget;
oversized trees use bounded streaming search without truncating the searchable
set. Unversioned callers retain fresh, uncached listing semantics.

The composer requests 64 candidates and displays eight ranked path suggestions.
Matching precedes the result cap, so deep attachments remain searchable beyond
the ordinary tree's 20,000-file cap. Bare `@` can return its final shallow-file
window as soon as one complete depth supplies 64 files, while the same scan
continues warming deeper queries. No second walk is needed. Ranking is shared
through `@zeros/protocol/workspace-paths`: tie order and searchable name/path
strings are prepared once, substring matches use native string search, and
fuzzy fallback stops once later candidates cannot improve the result window.

`mention-files-cache.ts` retains authoritative exact-cwd/query snapshots and a
warm index of up to 2,048 confirmed paths per workspace (16 inactive workspaces).
Typing filters those paths synchronously while the engine supplies the complete
ranking. An incomplete warm index can supply matches but cannot declare an
empty result. Authoritative results prune paths proven absent. Pointer/focus
intent warms the index; file/attachment signals and stale focus advance the
shared revision. Inactive queries do not initiate reads. Typing coalesces to the
newest waiting query, and a slow old workspace cannot delay a new workspace.

Background refresh preserves the highlighted item's semantic identity even
when rows reorder. A deleted selection is bounded to a surviving row. Changing
the query or reopening the menu still starts at the first result.

The prior filtering came from Git's standard exclusions and a dotfile-skipping
non-Git fallback. See the [Git `ls-files` documentation](https://git-scm.com/docs/git-ls-files)
for `--exclude-standard` and the distinction between files and collapsed
directory entries.
