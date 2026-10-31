# Price per-row SQL predicates by repeated round trips

The Pro-seat check added to `CLOUD_V2_LIVE_ACCESS` first cost about 400 buffer
hits per authority check: it called a SQL function per member and was never
inlined. An inlined rewrite cut buffers but planned slower on every request.

Causes: PostgreSQL inlines a SQL function only when it has no `SET` option, and
a scalar one only when its body has no sub-SELECT. node-pg sends unnamed
statements, so an inlined complex subquery is planned again on every request,
while a non-inlined SQL function keeps a cached plan.

Rule (principle 8): measure an authority predicate as the average round trip
over a few hundred executions against a realistic organization, not one
`EXPLAIN`. Join instead of calling a function per row, and give the common case a
cheap exit, as `organization_member_on_hold` does for members with Pro. Use a
scratch database (`CREATE DATABASE …`), never the one a running suite resets.

Target: `gotchas.md` (PostgreSQL) and the review checklist's database-cost
section.
