# Composer UI smoke shards

`pnpm test:ui-smoke` runs the complete real-browser suite in its original order.
Each invocation owns one Vite server, Chromium browser, incident watcher, and
failure accumulator. Teardown closes pages and the browser, terminates the Vite
process group, and exits explicitly so child pipes cannot keep CI running.

The three-shard partition is `scripts/ui-smoke/shards.json`. Run a shard with:

```sh
pnpm test:ui-smoke --shard=1/3
```

List scenario IDs without installing or starting Chromium or Vite:

```sh
pnpm --silent test:ui-smoke --list --format=json
pnpm --silent test:ui-smoke --list --shard=1/3 --format=json
```

`--silent` suppresses pnpm's script banner. `--list` alone prints one ID per line.
Unknown, duplicate, or malformed arguments
fail before server startup. The denominator must be 3 and the numerator must be
between 1 and 3.

`scripts/ui-smoke/scenarios.mjs` owns stable IDs, module entry points, page groups,
entry viewports, and origin requirements. The partition contains assignment sets;
execution always filters the original order rather than following JSON array
order. Every registered scenario must occur in exactly one shard. Add a new ID
to both the registry and partition, retain its original relative order, and run
the adjacent `ui-smoke-*` Vitest suites.

The default run preserves its shared page and inherited viewport changes. Shards
give each independent unit a fresh page and browser context at its original entry
viewport. Functions that derive an origin from `page.url()` receive a blank
same-origin fixture before their own navigation. Cloud Computer V2 retains its
base case and complete regression loop, with a fresh context for each profile.
Design-workspace children are individual units; their assertions remain in the
existing modules, and the original Design dispatcher remains available to the
standalone Design baseline runner.

`core-inline` keeps the composer/model-menu, diff/files (including silent diff
separator assertions), GitHub settings, and browser-retention envelopes together.
They share a page and console history. Its four phases preserve the original
Design and file-prefetch calls between the model-menu and diff/files envelopes.
All phases are assigned to the same shard. Subscription remains last because it
installs a clock that survives navigation; its shard context is also isolated.

Every shard enforces the uncaught-page-error invariant. Its successful checkpoint
is printed by shard 3 only, so the multiset of `check()` names from a full run
equals the union of the shard logs. Any shard with uncaught errors prints the
failed checkpoint and exits unsuccessfully. Scenario checks keep the original
failure-accumulation semantics.

Preflight runs `ui-smoke (1/3)` through `ui-smoke (3/3)` with fail-fast disabled.
The required `ui-smoke (composer)` aggregate runs even when a shard fails or is
cancelled and succeeds only when the complete matrix succeeds. Pull request CI
keeps its existing composer placeholder; the browser workload runs after merge.
