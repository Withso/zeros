# Playbook: refactor

For a behavior-preserving change to structure: rename, extract, inline, move,
deduplicate or delete. Features, UI, persisted state, wire contracts and
packaging stay unchanged (`RULES.md` §1). Numbers refer to
`agents/zstack/principles.md`.

1. **Map every reference before moving anything:** imports, tests, scripts,
   configs, workflows, manifests, generated-code paths, dynamic imports, string
   registries and docs (10). Persisted keys, IPC names, environment names, CSS
   custom properties and DOM hooks never change as a cosmetic cleanup.
2. **Pin the behavior first.** Find the tests that cover the code you will
   move, add characterization tests where coverage is missing, and run them
   green before changing anything.
3. **Subtract before adding.** Remove dead code and one-caller wrappers first,
   then reshape. Migrate every caller and delete the old API in the same change.
4. **When retiring a mode or placement,** fold each dead check to its surviving
   branch (a retired `isLocalGithubRead()` becomes `true`) and delete only the
   statements that touch retired members. Before committing, blame every
   removed line at the parent, group the lines by the PR that wrote them, and
   read each group from an unrelated PR to confirm that its surviving branch
   remains.
5. **Prove nothing changed.** Run the same tests before and after, the whole
   touched directories and every suite that imports moved code. A
   comments-only change passes `node scripts/zstack/comments.mjs verify`. After
   deleting a file or entry point, search for its path across `scripts/`,
   `agents/`, `.github/` and `docs/`, and run `pnpm build:engine` and
   `pnpm electron:compile` when an engine entry moved.
6. **Review and deliver** (`zstack-review`, `integrate-pr.md`).
