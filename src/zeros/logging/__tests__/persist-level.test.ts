// Renderer capture persistence gate (renderer-log.ts shouldPersistLevel).
//
// Packaged builds must not persist console.debug into app.jsonl — it's
// chatty-by-design tracing that was filling users' disks and padding the
// feedback export — while dev keeps all five levels. Split from
// renderer-log.test.ts (which covers serialization + the flush circuit) so
// the level-gate contract has its own named home.

import { describe, it, expect } from "vitest";
import { shouldPersistLevel } from "../renderer-log";

describe("shouldPersistLevel", () => {
  it("drops only debug in packaged builds (dev=false)", () => {
    expect(shouldPersistLevel("debug", false)).toBe(false);
    // Everything else still reaches the log store in production — warn/error
    // are the whole point, and log/info carry the lifecycle breadcrumbs.
    expect(shouldPersistLevel("log", false)).toBe(true);
    expect(shouldPersistLevel("info", false)).toBe(true);
    expect(shouldPersistLevel("warn", false)).toBe(true);
    expect(shouldPersistLevel("error", false)).toBe(true);
  });

  it("keeps every level in dev (dev=true)", () => {
    expect(shouldPersistLevel("debug", true)).toBe(true);
    expect(shouldPersistLevel("log", true)).toBe(true);
    expect(shouldPersistLevel("info", true)).toBe(true);
    expect(shouldPersistLevel("warn", true)).toBe(true);
    expect(shouldPersistLevel("error", true)).toBe(true);
  });
});
