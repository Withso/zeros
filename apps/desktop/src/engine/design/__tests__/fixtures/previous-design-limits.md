# Previous Design frame limits

`previous-design-limits.mjs` is a tree-shaken build of the actual engine canvas
codec and protocol page-catalog schemas at
`2435964e1bdde90623da1042449a6438131f5582`, origin/main before per-page frame
admission (256 frames per directory, stacking 0–256). The provenance JSON records
the retained source files, their SHA-256 hashes and the artifact hash. It
contains Zeros code (MIT); Zod is an external dependency.

Regenerate from the repository root, with that commit available locally:

```
node apps/desktop/src/engine/design/__tests__/fixtures/generate-previous-design-limits.mjs
```

`frame-limits-compatibility.test.ts` loads the frozen artifact without Git or a
deep checkout. It proves that an older build fails closed (it refuses to read,
and so never truncates or rewrites) a directory past its old cap, and that
both builds read and write identical bytes within the old limits. Do not
replace it with an approximation of the older schemas.
