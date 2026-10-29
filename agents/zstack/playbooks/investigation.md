# Playbook: investigation

For a read-only question: how does X work, why was Y built this way, are we
sure about Z, should we do A or B. The deliverable is a cited answer, not a
change.

1. **Restate the question** and what would settle it. A fact that running
   something can show is observed, not argued.
2. **Anchor in code.** Find the owning files and symbols and read the path end
   to end, in both placements.
3. **Recover the why from history:** `git log --follow -- <path>`,
   `git blame -L <range> <path>`, then the PR bodies
   (`gh pr view <n> --json title,body`), which record Why, What changes, Tests
   and Rollout. Eval cases in `agents/zstack/evals/cases/` record escaped bugs
   and their rules; folded lesson fragments stay readable with
   `git show 7b6eb9e6:agents/zstack/changes/<id>.md`.
4. **Measure instead of estimating.** Run the code, query read-only, count.
   Label each claim as measured, inferred or a guess (principle 16).
5. **Answer** with the conclusion first, then the evidence with `file:line`
   references, what you did not verify and why, and the options with their
   tradeoffs when the question asks for a decision. Change nothing unless asked.
