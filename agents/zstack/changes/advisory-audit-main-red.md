# Advisory-driven audit red on main

Main Preflight failed after two unrelated merges. Both production audits
failed, the incident controller listed the merged PRs as suspects, and the
automatic Alpha barrier waited its full poll on the red exact-source Preflight.
No code had changed. A zod advisory widened to every release below 4.6.6, and a
body-parser advisory was published the same evening. Before blaming a
commit-associated PR, compare the advisory's published and updated times with
the last green main run.

Repair both independent graphs: root and control plane. Do not override a
dependency across a major for a pinned provider runtime without reading how
that runtime uses it. Cursor SDK 1.0.37 calls single-argument `z.record()`,
which throws under zod 4. Its private zod 3 therefore has a reviewed exception,
bounded to that locked parent by `scripts/__tests__/audit-exceptions.test.ts`.

The public control plane moved to zod 4. Typecheck found the renamed types
(`ZodType<T, ZodTypeDef, I>` → `ZodType<T, I>`,
`SafeParseReturnType` → `ZodSafeParseResult`) and the single-argument
`z.record`. It did not catch that an enum-keyed `z.record` is exhaustive in
zod 4: the empty worker-polling default would have stopped startup. Use
`z.partialRecord` for partial maps. Run the database-backed files with
`TEST_DATABASE_URL`; without it, 50 control-plane files skip silently.

The same run exposed a smoke race: the layout menu sampled trigger focus
immediately after Escape. Radix restores it on the next task (see
`anchored-overlay-dismissal.md`), so the check now awaits it.

Encoded in `playbooks/ci-red.md`, `scripts/__tests__/audit-exceptions.test.ts`,
`apps/control-plane/src/worker-polling-config.test.ts`,
`scripts/ui-smoke-design-layout-children.mjs` and cases
`advisory-audit-exception-scope`, `zod4-enum-record-partial` and
`layout-menu-escape-focus`.
