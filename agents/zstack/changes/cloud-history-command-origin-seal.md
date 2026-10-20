# Retain a command's acknowledged history origin through idle wakes

- Symptom: a clean cloud stop followed by an idle wake and another stop made
  the next wake refuse valid terminal conversation history.
- Cause: the successor sealed an empty event stream, but rebuild bounded an
  earlier command's cursor by that successor. The prior correction handled
  mutation and recovered origins while its command fallback skipped stored
  origin seals. Existing repeated-wake tests kept every event cursor at zero
  and rewrote the history head during each cycle.
- Rule: exercise unchanged terminal history across repeated real sealed
  handoffs, with a nonzero original cursor and an idle successor at zero.
  Validate the exact retained seal, ACK, actor scope and origin bounds. A
  present invalid seal must not select a legacy fallback; missing legacy
  evidence retains its existing stricter envelope.
- Encoded in the sealed-history lifecycle and rebuild regression suites.
  Cover succeeded and cancelled commands, same-generation and replacement
  wakes, and the refusal controls before changing the source reader.
