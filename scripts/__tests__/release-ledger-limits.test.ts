import { describe, expect, it } from "vitest";
import {
  LEDGER_RETENTION_DAYS,
  MAX_LEDGER_BYTES as WRITER_BYTES,
  MAX_LEDGER_RELEASES as WRITER_RELEASES,
} from "../release/release-ledger";
import {
  MAX_LEDGER_BYTES as SERVER_BYTES,
  MAX_LEDGER_RELEASES as SERVER_RELEASES,
  SUPPORT_WINDOW_MS,
} from "../../apps/control-plane/src/client-compatibility";
import { LIMITS } from "../agent-runtime/config.mjs";

// The control plane deploys standalone, so it mirrors the writer's limits
// instead of importing them; this keeps the published ledger readable.
describe("release ledger limits", () => {
  it("lets every reader accept the largest ledger the writer publishes", () => {
    const releases = Array.from({ length: WRITER_RELEASES }, (_, index) => ({
      version: `10.10.10-alpha.${100_000 + index}`,
      publishedAt: new Date(Date.UTC(2026, 10, 7) + index).toISOString(),
      sourceSha: "f".repeat(40),
    }));
    const bytes = Buffer.byteLength(
      `${JSON.stringify({ version: 1, channel: "alpha", releases }, null, 2)}\n`,
    );
    for (const limit of [WRITER_BYTES, SERVER_BYTES, LIMITS.ledgerBytes]) {
      expect(bytes).toBeLessThanOrEqual(limit);
    }
    for (const limit of [SERVER_RELEASES, LIMITS.ledgerReleases]) {
      expect(WRITER_RELEASES).toBeLessThanOrEqual(limit);
    }
  });

  it("retains at least the control plane's support window", () => {
    expect(LEDGER_RETENTION_DAYS * 24 * 60 * 60 * 1000).toBeGreaterThanOrEqual(
      SUPPORT_WINDOW_MS,
    );
  });
});
