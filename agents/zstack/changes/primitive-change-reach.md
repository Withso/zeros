# A primitive change reaches every call shape

**Symptom.** Primitive changes passed the renderer suite and `check:ui` but
broke screens: `Button asChild` threw `React.Children.only` (Design layer
rows, the provider API key link), ListRow's transparent focus border moved
rows 1px off the subagent rail, and four ui-smoke scripts still pinned the
replaced tooltip, split-button, island and copy. A scratch run at a narrower
viewport than the registry's also reported a false mentions failure.

**Cause.** Unit tests rendered only the default call shape, and the smokes that
measure a primitive's computed look ran pages later, so each regression
surfaced far from the commit that made it.

**Rule.** After changing a primitive, test each call shape it supports
(asChild, loading, inside a Tooltip), run the ui-smoke scenarios that mount
it at the viewport `scripts/ui-smoke/scenarios.mjs` gives them, and update
every smoke that pins the old computed look in the same commit. A row's focus
edge is an inset ring plus the halo, never a border that takes layout space.

A shared class constant is a primitive too. Making `WORKBENCH_TITLE_ACTION_CLS`
the 28px header tool also grew the terminal session list's row close and run
buttons past their row, because that list reused the constant. List every
importer before changing one, and size each call by its context: header tools
28px, row actions 24px.

**Encoded in.** `playbooks/ui-design.md` step 6; eval cases
`button-aschild-single-child`, `listrow-focus-edge-layout` and
`shared-class-constant-reach`.
