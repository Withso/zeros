import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hash } from "../agent-runtime/contracts.mjs";
import {
  includesCommit,
  publicationReceipt,
  validateLedger,
  validatePublication,
} from "../agent-runtime/delivery.mjs";
const source = "a".repeat(40);

describe("desktop and cloud delivery evidence", () => {
  it("validates channel identity and immutable release sources", () => {
    const ledger = {
      version: 1,
      channel: "alpha",
      releases: [
        {
          version: "0.1.0-alpha.4",
          sourceSha: source,
          publishedAt: "2026-10-12T00:00:00.000Z",
        },
      ],
    };
    expect(validateLedger(ledger, "alpha")).toBe(ledger);
    expect(() => validateLedger(ledger, "beta")).toThrow();
    expect(() =>
      validateLedger(
        { ...ledger, releases: [ledger.releases[0], ledger.releases[0]] },
        "alpha",
      ),
    ).toThrow();
  });
  it("uses source ancestry to recognize inclusion by a later release", async () => {
    const github = { get: async () => ({ status: "ahead" }) };
    expect(await includesCommit(github, source, "b".repeat(40))).toBe(true);
    expect(
      await includesCommit(
        { get: async () => ({ status: "diverged" }) },
        source,
        "b".repeat(40),
      ),
    ).toBe(false);
    expect(
      await includesCommit(
        {
          get: async () => {
            throw new Error("unavailable");
          },
        },
        source,
        "b".repeat(40),
      ),
    ).toBe("unknown");
  });
  it("never treats a disabled publisher, failed run or missing receipt as cloud publication", () => {
    const input = { directory: "/not-read", runId: 1, attempt: 1, source };
    const diagnostic = {
      schema: "zeros.diagnostic/v1",
      component: "publication",
      stage: "disabled",
      ok: true,
      exitCode: 0,
    };
    expect(publicationReceipt({ ...input, diagnostic }).status).toBe(
      "disabled",
    );
    expect(
      publicationReceipt({
        ...input,
        diagnostic: { ...diagnostic, stage: "upload", ok: false, exitCode: 1 },
      }).status,
    ).toBe("failed");
    expect(publicationReceipt({ ...input, diagnostic: null }).status).toBe(
      "unknown",
    );
  });
  it("records only verified public pins/digests and keeps live qualification unknown", () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-receipt-"));
    try {
      const text = JSON.stringify({
        source: { commit: source },
        agents: {
          claude: { sdk: "1.0.0" },
          codex: { package: "1.0.0" },
          cursor: { sdk: "1.0.0" },
        },
      });
      writeFileSync(join(directory, "manifest.json"), text);
      writeFileSync(
        join(directory, "descriptor.json"),
        JSON.stringify({
          sourceCommit: source,
          manifestSha256: hash(text),
          runtimeId: `r1-${hash(text)}`,
        }),
      );
      const receipt = publicationReceipt({
        directory,
        runId: 1,
        attempt: 2,
        source,
        diagnostic: {
          schema: "zeros.diagnostic/v1",
          component: "publication",
          stage: "done",
          ok: true,
          exitCode: 0,
        },
      });
      expect(receipt).toMatchObject({
        status: "published",
        qualification: "unknown",
        pins: { claude: "1.0.0", codex: "1.0.0", cursor: "1.0.0" },
      });
      expect(
        validatePublication(receipt, {
          id: 1,
          run_attempt: 2,
          head_sha: source,
        }),
      ).toBe(receipt);
      expect(() =>
        validatePublication(receipt, {
          id: 1,
          run_attempt: 3,
          head_sha: source,
        }),
      ).toThrow("provenance");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
