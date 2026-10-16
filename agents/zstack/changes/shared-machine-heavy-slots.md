# Shared-machine heavy checks and mid-flight contract changes

- Symptom: one subagent's hung integration suite held the only heavy-check
  lock for over 10 minutes while another subagent waited; a contract froze
  with changes while two subagents were building on the draft.
- Cause: a single global lock without timeouts, and no channel that tells a
  running subagent about a changed contract.
- Rule: run heavy checks through a small number of shared slots, each with a
  timeout and per-test timeouts. Stop a running subagent and resume it with
  the delta before it builds on outdated text.
- Encoded in `skills/zstack/SKILL.md` (Master plus subagents).
