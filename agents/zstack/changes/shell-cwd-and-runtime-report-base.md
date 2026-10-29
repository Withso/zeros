# Background-job directories and runtime report bases

- Symptom: four local gates reported for #765 and an adjacent run on #763 came
  from the main checkout rather than the worktree under test. Cause:
  `cd X && (a) & (b) & wait` applies the `cd` only to the first background job.
  Rule: put `cd` inside every background job and record which tree produced
  each result. Encoded in `zstack-verify` gotchas.
- Symptom: #763's runtime report stayed "not qualified" although its CI and
  qualification job passed. Cause: the report requires the tested merge
  commit's first parent to equal the PR's current base; #764 had landed on
  `main` after that run started. Rule: after `main` moves, merge it into the held
  runtime PR, rerun CI and land other PRs only after it merges. Encoded in
  `zstack-verify` gotchas.
