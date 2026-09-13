import { describe, expect, it } from "vitest";
import { changesHistorySchema, changesHistoryKey } from "../changes-history";
describe("Changes history identity", () => {
  it("accepts groups and inclusive endpoints without retaining extra input fields", () => {
    for (const kind of ["commits", "turns", "last-turn"])
      expect(changesHistorySchema.parse({ kind, extra: "ignored" })).toEqual({
        kind,
      });
    expect(
      changesHistorySchema.parse({
        kind: "commit-range",
        from: "aaaaaaa",
        to: "bbbbbbb",
      }),
    ).toEqual({ kind: "commit-range", from: "aaaaaaa", to: "bbbbbbb" });
  });
  it("rejects incomplete ranges, unsafe refs and empty turn identities", () => {
    for (const selection of [
      { kind: "commit-range", from: "aaaaaaa" },
      { kind: "commit-range", from: "--flag", to: "bbbbbbb" },
      {
        kind: "turn-range",
        from: { chatId: "", turnId: "x" },
        to: { chatId: "c", turnId: "t" },
      },
    ])
      expect(changesHistorySchema.safeParse(selection).success).toBe(false);
  });
  it("distinguishes both endpoints and both chat owners", () => {
    const range = {
      kind: "turn-range" as const,
      from: { chatId: "c", turnId: "1" },
      to: { chatId: "c", turnId: "2" },
    };
    expect(changesHistoryKey(range)).not.toBe(
      changesHistoryKey({ ...range, to: { chatId: "d", turnId: "2" } }),
    );
    expect(changesHistoryKey(range)).not.toBe(
      changesHistoryKey({ ...range, from: { chatId: "c", turnId: "0" } }),
    );
  });
});
