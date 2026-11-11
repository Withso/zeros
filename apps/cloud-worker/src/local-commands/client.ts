import { randomUUID } from "node:crypto";
import { LOCAL_COMMAND_LIMITS, LocalCommandReceiptSchema, type LocalCommandInput, type LocalCommandReceipt, type LocalCommandResult } from "@zeros/protocol/local-commands";

/** One worker control-plane call (W credential, boot and feature headers). */
export type LocalCommandCall = (method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, signal?: AbortSignal) => Promise<Record<string, unknown>>;

/** The control plane did not give a terminal answer. A transport failure is
 * unknown: never an invented denied, interrupted or mac_not_connected. */
export class LocalCommandUnknownError extends Error {
  constructor(message = "The local command's outcome is unknown: the control plane could not be reached.") { super(message); }
}

const POLL_WAIT_MS = 25_000, POLL_TIMEOUT_MS = 35_000, CALL_TIMEOUT_MS = 10_000, AFTER_CANCEL_MS = 10_000;
const status = (error: unknown) => (error as { status?: unknown } | null)?.status;
/** A 4xx other than 408 and 429 is the server's final word on this request. */
const refused = (error: unknown) => typeof status(error) === "number" && (status(error) as number) >= 400 && (status(error) as number) < 500 && status(error) !== 408 && status(error) !== 429;

export async function requestLocalCommand(call: LocalCommandCall, request: { chatId: string; executionId: string; input: LocalCommandInput; contextId?: string }, signal: AbortSignal,
  options: { requestId?: string; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ result: LocalCommandResult; acknowledge(): Promise<void> }> {
  // Fresh per tool call and kept for every retry, so a lost reply never creates a second request.
  const requestId = options.requestId ?? randomUUID();
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const ceiling = new AbortController();
  const timer = setTimeout(() => ceiling.abort(), LOCAL_COMMAND_LIMITS.approvalMs + (request.input.timeoutMs ?? LOCAL_COMMAND_LIMITS.defaultTimeoutMs) + 30_000);
  const stopping = AbortSignal.any([signal, ceiling.signal]);
  const parse = (value: Record<string, unknown>) => {
    const receipt = LocalCommandReceiptSchema.parse(value);
    if (receipt.requestId !== requestId) throw new LocalCommandUnknownError("The control plane answered for another request.");
    return receipt;
  };
  const done = (receipt: LocalCommandReceipt) => {
    if (!receipt.result) throw new LocalCommandUnknownError();
    return { result: receipt.result, acknowledge: async () => { await call("POST", `local-commands/${requestId}/ack`, {}, CALL_TIMEOUT_MS).catch(() => {}); } };
  };
  let attempt = 0;
  const backoff = () => sleep(Math.min(5_000, 250 * 2 ** Math.min(attempt++, 5)));
  try {
    let receipt: LocalCommandReceipt | undefined;
    while (!receipt && !stopping.aborted) {
      try { receipt = parse(await call("POST", "local-commands", { requestId, ...request }, CALL_TIMEOUT_MS, stopping)); }
      catch (error) {
        if (error instanceof LocalCommandUnknownError || refused(error)) throw error instanceof LocalCommandUnknownError ? error : new LocalCommandUnknownError("The control plane refused the local command request.");
        if (!stopping.aborted) await backoff();
      }
    }
    attempt = 0;
    while (receipt && receipt.state !== "terminal" && !stopping.aborted) {
      try { receipt = parse(await call("GET", `local-commands/${requestId}?waitMs=${POLL_WAIT_MS}`, undefined, POLL_TIMEOUT_MS, stopping)); attempt = 0; }
      catch (error) {
        if (error instanceof LocalCommandUnknownError || refused(error)) throw error instanceof LocalCommandUnknownError ? error : new LocalCommandUnknownError();
        if (!stopping.aborted) await backoff();
      }
    }
    if (receipt?.state === "terminal") return done(receipt);
    // Stop or the ceiling: cancel by the same id (idempotent, also before a
    // create was confirmed), then report the server's terminal answer.
    const settling = new AbortController(), settleTimer = setTimeout(() => settling.abort(), AFTER_CANCEL_MS);
    const settle = settling.signal;
    for (let tries = 0; tries < 3 && !settle.aborted; tries++) {
      try { receipt = parse(await call("POST", `local-commands/${requestId}/cancel`, {}, CALL_TIMEOUT_MS, settle)); break; }
      catch (error) { if (refused(error)) throw new LocalCommandUnknownError(); await sleep(250); }
    }
    while (receipt && receipt.state !== "terminal" && !settle.aborted) {
      try { receipt = parse(await call("GET", `local-commands/${requestId}?waitMs=5000`, undefined, CALL_TIMEOUT_MS, settle)); }
      catch { if (!settle.aborted) await sleep(250); }
    }
    clearTimeout(settleTimer);
    if (receipt?.state === "terminal") return done(receipt);
    throw new LocalCommandUnknownError();
  } finally { clearTimeout(timer); }
}
