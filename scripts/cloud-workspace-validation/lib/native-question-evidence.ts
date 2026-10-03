import type { QuestionRequest } from "@zeros/protocol/agent-events";

/** Counts canonical request metadata only. No content, correlation ids, tool
 * names or provider-private fields enter this accumulator. */
export class NativeQuestionEvidence {
  private requests = 0;
  private overflowed = false;
  private readonly sources: Record<QuestionRequest["source"] | "unknown", number> =
    { native_dialog: 0, native_rpc: 0, inferred_from_text: 0, unknown: 0 };
  private readonly blocking = { yes: 0, no: 0, unknown: 0 };
  private readonly elicitation = { mcp: 0, notIndicated: 0, unknown: 0 };

  observe(value: unknown): void {
    if (this.requests === 2048) { this.overflowed = true; return; }
    this.requests++;
    const request = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const source = request.source;
    if (source === "native_dialog" || source === "native_rpc" || source === "inferred_from_text") this.sources[source]++;
    else this.sources.unknown++;
    if (request.blocking === true) this.blocking.yes++;
    else if (request.blocking === false) this.blocking.no++;
    else this.blocking.unknown++;
    // The maintained MCP mapper sets this exact canonical combination for
    // both form and URL elicitation. Absence does not identify an RPC subtype.
    if (request.allowDecline === true) {
      if (source === "native_rpc" && request.blocking === true) this.elicitation.mcp++;
      else this.elicitation.unknown++;
    } else if (request.allowDecline === false || request.allowDecline === undefined) this.elicitation.notIndicated++;
    else this.elicitation.unknown++;
  }

  summary() {
    return { version: 1 as const, requests: this.requests, overflowed: this.overflowed,
      sources: { ...this.sources }, blocking: { ...this.blocking }, elicitation: { ...this.elicitation } };
  }
}
