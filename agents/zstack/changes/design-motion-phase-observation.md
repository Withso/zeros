# Observe transient animation phases in the browser

- Symptom: the motion smoke observed an alternating cycle, then received the
  next cycle's direction after pressing Pause.
- Cause: progressively spaced host-side polling observed the 1.2-second cycle
  near its end, leaving too little time for real pointer input to arrive.
- Rule: observe a transient native animation phase on the owning frame's
  animation frames, then use the real input path. Keep the observation deadline
  and direction assertion; do not substitute longer sleeps or accept either
  direction. Compare the same bounded input-delay control before and after.
- Encoded in `runDesignMotionAlternateSettingsEditSmoke`, which keeps its
  paused-pose, settings-edit and fractional-endpoint assertions unchanged.
