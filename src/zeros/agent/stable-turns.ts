import type { Turn } from "./turn-container";

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
  const stable = next.map((turn) => {
    const prior = previousById.get(identity(turn));
    return prior && sameTurn(prior, turn) ? prior : turn;
  });
  if (
    stable.length === previous.length &&
    stable.every((turn, index) => turn === previous[index])
  ) {
    return previous as Turn[];
  }
  return stable;
}
