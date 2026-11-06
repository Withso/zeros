# Disarm a PR before it becomes a CI-definition PR

Target: `playbooks/integrate-pr.md` step 7 (CI-definition PRs).

- **Symptom.** A PR armed through `pnpm agent:merge` while it changed only
  product code then took a dependency upgrade, adding `package.json` and
  `pnpm-lock.yaml`: CI-definition paths that only the owner may merge.
- **Cause.** The wrapper checks CI-definition paths when it arms. GitHub
  keeps auto-merge enabled when someone with write access pushes, so the new
  head could merge on green without the owner.
- **Rule.** Before pushing a CI-definition path to an armed PR, disarm it
  with the GraphQL `disablePullRequestAutoMerge` mutation, confirm
  `autoMergeRequest` is null, and leave the merge to the owner.
- **Encoded in.** Guidance only. Proposal for the owner: a merge-gate check
  that fails a CI-definition PR whose auto-merge an agent enabled.
