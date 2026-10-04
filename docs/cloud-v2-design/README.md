# Zeros Cloud v2 — design reference branch (not for merge)

Reference material for the Cloud v2 implementation PRs (Phases B–E). Implementation PRs branch
from `main`, not from this branch; read these files with
`git fetch origin cloud-v2/design && git show origin/cloud-v2/design:docs/cloud-v2-design/<file>`.

Reading order and authority:
1. `design-amendments.md` — orchestrator amendments; OVERRIDE the designs where they conflict.
2. `design-b-runtime.md` — Phase B: runtime bundles, v4 base, `/zeros` facade, admission, pins.
3. `design-cd-computer.md` — Phase C (Cloud Computer v2) and Phase D (admin workspace + tools).
4. `plan.md` — approved plan; §8 locked product decisions, §9 internal-first phases.
5. Evidence: `diag-alpha.md` (Alpha diagnosis), `boat-timings.md` (measured Boat lifecycle),
   `conductor-reference.md` (what we mirror), `boat-openapi.json` (Boat API, cached 2026-10-04).

Citations to `.context/...` paths refer to the orchestrator's workspace; the same documents are here.
