import { describe, expect, it } from "vitest";
import { BusyLog } from "./busy-log.js";

describe("BusyLog", () => {
  it("writes one line per workspace and reason per minute, counting the refusals in between", () => {
    const lines: string[] = []; let now = 0;
    const log = new BusyLog({ warn: line => lines.push(line) }, () => now);
    const id = "11111111-2222-4333-8444-555555555555";
    log.record("begin", id, "boot_not_clean");
    for (let i = 0; i < 40; i++) { now += 1_000; log.record("begin", id, "boot_not_clean"); }
    log.record("begin", id, "chat_busy");
    now = 61_000; log.record("begin", id, "boot_not_clean");
    expect(lines).toEqual([
      "[cloud-v2] begin busy reason=boot_not_clean workspace=11111111",
      "[cloud-v2] begin busy reason=chat_busy workspace=11111111",
      "[cloud-v2] begin busy reason=boot_not_clean workspace=11111111 refusals=41",
    ]);
  });
});
