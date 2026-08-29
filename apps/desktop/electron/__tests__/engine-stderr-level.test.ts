import { describe, expect, it } from "vitest";

import { classifyEngineStderrLine } from "../engine-stderr-level";

describe("classifyEngineStderrLine", () => {
  it("does not report successful slow-operation diagnostics as errors", () => {
    expect(
      classifyEngineStderrLine("[workspace] git.hasChanges took 2140ms"),
    ).toBe("warn");
    expect(
      classifyEngineStderrLine(
        "[zsr] retired codex in 1633ms (stop=12ms reclaim=1621ms)",
      ),
    ).toBe("log");
    expect(
      classifyEngineStderrLine(
        "[workspace] slow operations detected (first: git.diff 5429ms); aggregating for 10000ms",
      ),
    ).toBe("warn");
    expect(
      classifyEngineStderrLine(
        "[workspace] slow-operation summary: 250 calls; git.diff=250 avg=2188ms max=2250ms",
      ),
    ).toBe("warn");
  });

  it("keeps expected provider recovery notices out of the error level", () => {
    expect(
      classifyEngineStderrLine(
        "[codex-app-server] thread/resume found no rollout for thread-1; auto-starting a fresh thread",
      ),
    ).toBe("warn");
    expect(
      classifyEngineStderrLine(
        "[codex/binary-resolver] no bundled codex resolved (no configured path)",
      ),
    ).toBe("warn");
  });

  it("recognizes Cursor timing telemetry but preserves real SDK failures", () => {
    expect(
      classifyEngineStderrLine(
        "[cursor-host] ready in 812ms (@cursor/sdk require=700ms)",
      ),
    ).toBe("log");
    expect(
      classifyEngineStderrLine(
        "[cursor-host]   ↳ @  30ms  400ms tls api2.cursor.sh:443 (connected)",
      ),
    ).toBe("log");
    expect(
      classifyEngineStderrLine(
        "[cursor-host] run 1 first model output after 8927ms (cold host) — " +
          "4913ms across 8 traced op(s) (55%), 4014ms untraced in-process; " +
          "slowest fetch POST https://api2.cursor.sh/auth/exchange_user_api_key 2567ms",
      ),
    ).toBe("log");
    expect(
      classifyEngineStderrLine(
        "[cursor-host] (set ZEROS_CURSOR_TRANSPORT_DEBUG=1 for the per-operation breakdown of these waits)",
      ),
    ).toBe("log");
    expect(
      classifyEngineStderrLine(
        "[cursor-host] slow tls api2.cursor.sh:443 took 3200ms (tcp-connected)",
      ),
    ).toBe("log");
    // @cursor/sdk's own degraded-but-working notice, on every host.
    expect(
      classifyEngineStderrLine(
        "[cursor-host] shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed",
      ),
    ).toBe("warn");
    expect(
      classifyEngineStderrLine(
        "[cursor-host] Error initializing ignore mapping: Ripgrep path not configured",
      ),
    ).toBe("error");
    expect(
      classifyEngineStderrLine(
        "[design-territory] reconciliation failed: operation still settling",
      ),
    ).toBe("error");
  });
});
