export interface TranscriptRetentionPins {
  /** The chat still owns one of the bounded retained transcript views. */
  retained: boolean;
  /** A local prompt pipeline may read/promote message objects in its finally. */
  sending: boolean;
  /** FIFO placeholders are renderer-only until they are promoted and written. */
  queued: boolean;
  /** A queued-message edit is holding those same placeholder objects. */
  queueHeld: boolean;
  /** Session create/load carries the existing transcript across its reset. */
  ensuring: boolean;
}

/** Exact-chat safety gate for releasing a transcript payload. Remote/live
 *  runtime activity is intentionally not a pin: its routing shell remains in
 *  memory and SQLite receives the durable stream. Only local operations that
 *  still hold or mutate renderer message objects delay eviction. */
export function shouldEvictTranscriptPayload(
  pins: TranscriptRetentionPins,
): boolean {
  return !(
    pins.retained ||
    pins.sending ||
    pins.queued ||
    pins.queueHeld ||
    pins.ensuring
  );
}

/** Invalidate one chat's in-flight disk request. A late resolution checks the
 *  missing identity and drops its result instead of re-residenting an evicted
 *  payload. */
export function invalidateTranscriptRequest<T>(
  requests: Map<string, T>,
  chatId: string,
): void {
  requests.delete(chatId);
}

export function isCurrentTranscriptRequest<T>(
  requests: ReadonlyMap<string, T>,
  chatId: string,
  request: T,
): boolean {
  return requests.get(chatId) === request;
}

/** Identity-checked release: an old request's finally must not delete the
 *  replacement that a fast reopen installed under the same chat id. */
export function releaseTranscriptRequest<T>(
  requests: Map<string, T>,
  chatId: string,
  request: T,
): void {
  if (isCurrentTranscriptRequest(requests, chatId, request)) {
    requests.delete(chatId);
  }
}
