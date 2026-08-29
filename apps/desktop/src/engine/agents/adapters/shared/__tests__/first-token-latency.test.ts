// The shared time-to-first-token measurement the Claude and Codex adapters
// report through, giving them the parity with the Cursor host that made a
// slow Cursor turn attributable and a slow Claude turn a black box.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_FIRST_TOKEN_SLOW_MS,
  FirstTokenLatency,
  firstTokenSlowMs,
} from "../first-token-latency";

const at = (base: number, offsetMs: number) => base + offsetMs;

describe("FirstTokenLatency", () => {
  it("stays silent for a turn that starts talking promptly", () => {
    const t = new FirstTokenLatency("claude-sdk");
    t.beginTurn(1_000);
    expect(t.firstOutput({}, at(1_000, 4_999))).toBeNull();
  });

  it("reports once, on the first output-bearing event of the turn", () => {
    const t = new FirstTokenLatency("claude-sdk");
    t.beginTurn(1_000);
    const line = t.firstOutput(
      { cold: true, model: "claude-haiku-4-5" },
      at(1_000, 11_942),
    );
    expect(line).toBe(
      "[claude-sdk] first model output after 11942ms " +
        "(cold session — first turn; model=claude-haiku-4-5)",
    );
    // Every later event in the same turn is a no-op — this is called from
    // inside a hot stream loop.
    expect(t.firstOutput({}, at(1_000, 12_000))).toBeNull();
    expect(t.awaitingFirstOutput).toBe(false);
  });

  it("labels later turns by index rather than calling them cold", () => {
    const t = new FirstTokenLatency("codex");
    t.beginTurn(0);
    t.firstOutput({}, 6_000);
    t.beginTurn(10_000);
    expect(t.firstOutput({ model: "gpt-5.6-luna" }, 20_000)).toBe(
      "[codex] first model output after 10000ms " +
        "(turn #2 in this session; model=gpt-5.6-luna)",
    );
  });

  it("does not attribute a turn's first token to the next turn", () => {
    // A turn that errored or was cancelled before producing anything leaves a
    // live clock behind; the next turn's first frame would then be reported as
    // an enormous wait that never happened.
    const t = new FirstTokenLatency("codex");
    t.beginTurn(0);
    t.endTurn();
    expect(t.firstOutput({}, 60_000)).toBeNull();
    t.beginTurn(60_000);
    expect(t.firstOutput({}, at(60_000, 1_000))).toBeNull();
  });

  it("carries provider-specific detail through to the line", () => {
    const t = new FirstTokenLatency("claude-sdk", 1_000);
    t.beginTurn(0);
    expect(
      t.firstOutput(
        { cold: true, detail: "promptTokens=28580 cacheRead=0%" },
        5_000,
      ),
    ).toBe(
      "[claude-sdk] first model output after 5000ms " +
        "(cold session — first turn; promptTokens=28580 cacheRead=0%)",
    );
  });
});

describe("firstTokenSlowMs", () => {
  it("defaults to the Cursor host's threshold so the three providers agree", () => {
    expect(firstTokenSlowMs({})).toBe(DEFAULT_FIRST_TOKEN_SLOW_MS);
  });

  it("honors a positive override and ignores junk", () => {
    expect(firstTokenSlowMs({ ZEROS_FIRST_TOKEN_SLOW_MS: "250" })).toBe(250);
    for (const raw of ["0", "-1", "abc", ""]) {
      expect(firstTokenSlowMs({ ZEROS_FIRST_TOKEN_SLOW_MS: raw })).toBe(
        DEFAULT_FIRST_TOKEN_SLOW_MS,
      );
    }
  });
});
