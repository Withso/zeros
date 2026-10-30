---
name: zstack-correct
description: "On an explicit request, investigate repeated mistakes in Zeros history and replace a weak rule with an enforcer proved against a real past instance."
globs: "**"
invocation: user
---

# zstack-correct

Run only when the user explicitly asks for `zstack-correct` or asks to mine
repository history for recurring mistakes. Never start it unprompted. Routine
end-of-loop learning remains `zstack-learn`; a whole session retrospective is
`zstack-reflect`. Follow `zstack` and the user's chosen orchestration mode.

## Gather evidence at one revision

Pin the starting commit and retain the report in private scratch:

```sh
node scripts/zstack/history.mjs --revision <full-sha> --limit 20
node scripts/zstack/history.mjs --revision <full-sha> --limit 20 --json
```

The miner reads committed pack files and first-parent Git history at that
revision. It groups evals by area and cited principle, groups `judgment only`
rules by section, and finds reverts and fixes that touch a file repeatedly.
Reports contain case IDs, rule IDs and fingerprints, commit SHAs and redacted
subjects; never commit bodies or diffs. Dirty and untracked files are excluded.
File history clusters exclude pack records (`agents/zstack/**`), provider
metadata (`.agents/`, `.claude/`, `.cursor/`) and changelog files; coverage counts
the unique excluded paths. `docs/` stays eligible because contracts can be
correction targets. Recording a lesson alongside a fix is not itself recurrence.

Default bounds are 500 commits and 10 clusters; `--max-commits` accepts 1–2000
and `--limit` 1–100. Scores weight each case by 2, judgment rule by 3, revert by
5 and fix after the first by 4. Ties sort by cluster ID. `--json` retains all
evidence for the selected clusters; the table samples it. Keep the revision,
coverage and omitted-cluster count with the findings. Unresolved fix references,
uncited cases and truncated or shallow history are gaps, not negative evidence.
Use `--kind area|principle|judgment|history` to examine a source independently
when high-volume clusters crowd out the others; the default is `all`.

Mining is offline: it never fetches missing objects. `zstack_history_git_unavailable`
means required local objects or Git are unavailable; `git_version` refuses an
old promisor reader that cannot disable lazy fetch. Use an existing complete
clone or stop and name the gap. `pack_invalid`, `pack_limit`, `output_limit` and
`arguments_invalid` also fail closed; their full codes start `zstack_history_`.
Do not silently repair or fetch history as part of mining.

## Choose one correction

Rankings are investigation leads. Shared file touches, large areas and generic
principles do not prove a shared cause. Inspect concrete historical source and
the relevant cases, current tests and enforcement rows. Preserve credential
boundaries; do not copy raw history into reports.

For each candidate, state the repeated mistake, its distinct past instances,
the missing boundary and the current enforcer's gap. Reject clusters that only
share a filename, are already held by a sufficient gate, or require unrelated
product changes. Choose one scoped correction within the user's authorization.

Prefer an API or type that excludes the invalid state, then a lint or script
gate, then a focused regression through the real boundary. A new instruction
alone does not complete a correction. Preserve runtime behavior and serialized
contracts; account for Local Personal, organization-local and cloud placements.
Changes to safety rules or CI definitions need the owner under repository policy.

## Prove the enforcer against history

1. Record the actual past instance: case ID or commit SHA, source path and the
   invalid behavior. Add a regression that fails before the enforcer is fixed.
   A synthetic mistake that merely resembles the incident is insufficient.
2. Implement the enforcer and make the current-source check pass. If it is a
   static gate, exercise it through a replay-supported Vitest check. The
   assertion must test the prohibited behavior, not a copy of the implementation.
3. Add `agents/zstack/evals/seeds/<id>.json` with `file`, `before` and `after`:
   one exact current-source string and the replacement that restores the real
   historical mistake. Add the matching seeded case in `evals/cases/<id>.json`
   with its area, historical evidence in `rule`, and the enforcer's check.
   Follow `zstack-eval` for `fixedBy`; `pending` is authoring-only and must be
   replaced with the PR reference before handoff.
4. Commit the tested source, test, case and seed. Validate the cases, then run:

   ```sh
   node scripts/zstack/evals.mjs --validate
   node scripts/zstack/eval-replay.mjs --case <id> --revision <full-tested-sha> --execute --receipt <new-private-file>
   ```

   Pass the task's `--mode`, `--agent` and, for a peer pair, `--master`. The seed
   changes only a disposable projection. Require **caught**, with the same
   assertion passing on the fixed source and failing after the seed. An import
   error, timeout, missing prerequisite or **unverified** result is no proof.
5. Record the enforcer in `enforcement.md` if it holds a mapped rule; preserve
   that rule's fingerprint unless its authoritative source changed. Otherwise
   cite the new case in the relevant principle's `Cases:`. Run the mapping and
   pack tests. Do not claim a rule is fully enforced beyond the covered inputs.

## Deliver

Run `zstack-verify`, eval validation and `zstack-review`; regenerate provider
copies with `pnpm design:docs` if a skill changed. Report the starting and tested
SHAs, pack version, chosen cluster, real historical evidence, enforcer, green
check and caught replay receipt. Name rejected leads and remaining coverage
gaps. Use the normal PR sections and review/merge rules; no automatic bulk
cleanup, network mining or additional agent sessions follows from this command.
