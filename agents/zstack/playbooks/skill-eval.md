# Playbook: evaluate a pack change

For a change to a zstack skill, playbook or principle large enough to change
agent behavior. A pack edit shapes every later task, so test it like an
experiment. The candidate sessions it starts need the user's authorization.

1. **Frame.** Name the variant, the behavior that counts as success, and a
   rubric of three to six concrete criteria. Only the judge sees the rubric.
2. **Prepare two checkouts** at the same base, one with the current pack and
   one with the variant. No path, branch or prompt a candidate can see mentions
   an evaluation, a candidate or a judge.
3. **Write one organic task** that a user would plausibly send: the goal, with
   no hint of what is measured or that another candidate exists. A task taken
   from an eval case's escaped bug has a checkable outcome.
4. **Run the candidates** on the authorized models, with the same prompt in
   each checkout and no access to each other's work.
5. **Judge blind.** One judge from a different model family scores both
   outputs under neutral labels against the rubric. Grade what each candidate
   actually read and changed, from its transcript and diff, never from its own
   account.
6. **Read every output yourself** and compare with the verdict. Disagreement
   means a biased judge or an ambiguous rubric.
7. **Report** the variant, rubric, per-candidate notes, verdict, your synthesis
   and whether to adopt it. A change that does not improve behavior is not
   adopted, and replay evals (`zstack-eval`) must not regress either way.
