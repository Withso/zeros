# Cap slow background steps so waiting users keep their slots

- **Symptom.** Saving a checkpoint made a stop take seconds to minutes. Four
  stops at once would have filled all four lifecycle slots, and creates and
  wakes would again have queued behind them.
- **Cause.** One bounded pool served latency-sensitive steps (creates and
  wakes, which someone is waiting for) and slow background steps alike, and
  each claim took the oldest rows of every state.
- **Rule.** When a step class becomes slow, cap that class below the pool size.
  Claim the latency-sensitive states first, then the capped class into its
  remaining slots. Test a burst of the slow class against an arriving create.
- **Encoded in.** `STOPPING_SLOTS` and the two claims in
  `apps/control-plane/src/cloud/lifecycle.ts`, with "keeps creates and wakes
  moving while two stops save their checkpoints" in `lifecycle.test.ts`.
