Runtime availability polling kept two surface timers alive while the window
was hidden. Share one exact-key observer with a bounded visible fallback,
retain intent-warmed snapshots, and cancel passive timers while reads are
pending. The review also caught a changed startup cadence and a focus event
postponing another caller's read deadline; retain the original 5s startup / 2s
transition behavior and let the active read own its deadline. Fake-clock tests
drive the real components, cache and observer through visibility, pending
reads, failures and A → B → A. The contract is in
`docs/ui-interaction-performance.md` and its eval case.

A separate handoff missed new-file Git metadata: GNU patch accepted it, but
`git apply` refused. Emit `git diff --binary` from an index, mark new files with
`git add -N`, and verify Git application plus all source hashes. The
integrate-pr playbook and `frozen-handoff-git-apply` scenario retain that lesson.
