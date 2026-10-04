import { turnKey, type Turn } from "./turn-grouping";

function sameTurn(previous: Turn, next: Turn): boolean {
  return (
    previous.userPrompt === next.userPrompt &&
    previous.recordedTurnId === next.recordedTurnId &&
    previous.recordedStartedAt === next.recordedStartedAt &&
    previous.isSteer === next.isSteer &&
    previous.events.length === next.events.length &&
    previous.events.every((event, index) => event === next.events[index]) &&
    previous.providerEvents.length === next.providerEvents.length &&
    previous.providerEvents.every(
      (event, index) => event === next.providerEvents[index],
    )
  );
}

function identity(turn: Turn): string {
  if (turn.userPrompt) return `turn-${turn.userPrompt.id}`;
  if (turn.events[0]) return `turn-evt-${turn.events[0].id}`;
  return "turn-empty";
}

/** Restore structural sharing after grouping a streamed flat message array.
 * `groupMessagesIntoTurns` necessarily creates new arrays; without this pass,
 * every historical TurnEventList receives a new `events` reference on every
 * token and React.memo cannot skip it. */
export function stabilizeTurns(
  previous: readonly Turn[],
  next: readonly Turn[],
): Turn[] {
  if (next.length === 0)
    return previous.length === 0 ? (previous as Turn[]) : [];
  const previousById = new Map(previous.map((turn) => [identity(turn), turn]));
  // The leading resident segment can gain or lose its prompt as history is
  // prepended or trimmed. Its retained durable rows still own the same mounted
  // subtree. Index only visual events, not providerEvents shared across steers;
  // distinct prompt segments must remain distinct. This index is transient.
  const hasPartial =
    previous.some((turn) => !turn.userPrompt) ||
    next.some((turn) => !turn.userPrompt);
  const previousByEventId = new Map<string, Turn>();
  if (hasPartial) {
    for (const turn of previous) {
      for (const event of turn.events) previousByEventId.set(event.id, turn);
    }
  }
  const claimed = new Set<Turn>();
  const stable = next.map((turn) => {
    let prior = previousById.get(identity(turn));
    if (prior && claimed.has(prior)) prior = undefined;
    if (!prior && hasPartial) {
      for (const event of turn.events) {
        const candidate = previousByEventId.get(event.id);
        if (
          candidate &&
          !claimed.has(candidate) &&
          (!turn.userPrompt || !candidate.userPrompt)
        ) {
          prior = candidate;
          break;
        }
      }
    }
    if (!prior) return turn;
    claimed.add(prior);
    if (sameTurn(prior, turn)) return prior;
    const priorKey = turnKey(prior);
    return priorKey === turnKey(turn) ? turn : { ...turn, renderKey: priorKey };
  });
  if (
    stable.length === previous.length &&
    stable.every((turn, index) => turn === previous[index])
  ) {
    return previous as Turn[];
  }
  return stable;
}
