# Review complete SDK inventories and native accounting

The upgrade comment showed 20 declarations, but the complete artifact contained
256. Schema references also broke a gate that assumed inline objects. Review
the complete fingerprint inventory, and resolve named schemas while keeping the
tool discriminator check exhaustive. Encoded in the runtime-review documentation
and Cursor's `sdk-tool-type-coverage.test.ts`.

Both Cursor pins report input inclusive of cache reads and writes. Zeros added
the caches again because an older SDK's derived total used that formula. A
cache-heavy native probe exposed the error; 1.1.0 corrects the derived total but
does not change the component counts. Verify native component semantics before
changing accounting, including independently pinned placements and stored runs.
Encoded in Local and cloud usage regressions, the real SDK store compatibility
test and `evals/cases/cursor-cache-inclusive-usage.json`.
