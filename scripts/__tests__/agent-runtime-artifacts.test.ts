import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  downloadArtifact,
  jsonFromZip,
  validateRun,
} from "../agent-runtime/artifacts.mjs";

function zip(name = "report.json", text = '{"schema":1}', mode = 0x8000) {
  const data = Buffer.from(text),
    compressed = deflateRawSync(data),
    filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(filename.length, 26);
  const center = Buffer.alloc(46);
  center.writeUInt32LE(0x02014b50);
  center.writeUInt16LE(8, 10);
  center.writeUInt32LE(compressed.length, 20);
  center.writeUInt32LE(data.length, 24);
  center.writeUInt16LE(filename.length, 28);
  center.writeUInt32LE((mode << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(center.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + compressed.length, 16);
  return Buffer.concat([local, filename, compressed, center, filename, end]);
}

describe("untrusted Actions artifact boundary", () => {
  it("reads only one bounded regular JSON entry without extraction", () => {
    expect(jsonFromZip(zip(), "report.json")).toEqual({ schema: 1 });
    for (const bytes of [
      zip("../report.json"),
      zip("report.json", "{}", 0xa000),
      zip("report.json", JSON.stringify({ oversized: "x".repeat(1000) })),
    ]) {
      expect(() => jsonFromZip(bytes, "report.json", 100)).toThrow();
    }
    const multiple = zip();
    multiple.writeUInt16LE(2, multiple.length - 12);
    expect(() => jsonFromZip(multiple, "report.json")).toThrow();
  });
  it("requires the expected workflow, immutable source, repository and attempt", () => {
    const run = {
      id: 1,
      run_attempt: 2,
      repository: { full_name: "Withso/zeros" },
      head_repository: { full_name: "Withso/zeros" },
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      head_sha: "a".repeat(40),
      status: "completed",
    };
    const expected = {
      id: 1,
      attempt: 2,
      workflow: "ci.yml",
      events: ["pull_request"],
      head: run.head_sha,
      completed: true,
    };
    expect(validateRun(run, expected)).toBe(run);
    for (const patch of [
      { run_attempt: 1 },
      { head_sha: "b".repeat(40) },
      { path: ".github/workflows/other.yml" },
      { head_repository: { full_name: "attacker/zeros" } },
    ])
      expect(() => validateRun({ ...run, ...patch }, expected)).toThrow();
  });
  it("never forwards a GitHub token to signed download storage", async () => {
    const headers: any[] = [];
    const github = {
      token: "fixture-only",
      prefix: "/repos/Withso/zeros",
      fetch: async (_: string, options: any) => {
        headers.push(options.headers);
        return headers.length === 1
          ? new Response(null, {
              status: 302,
              headers: {
                location: "https://example.blob.core.windows.net/file",
              },
            })
          : new Response(zip());
      },
    };
    await downloadArtifact(
      github,
      { id: 1, expired: false, size_in_bytes: 200 },
      1000,
    );
    expect(headers[0].authorization).toBe("Bearer fixture-only");
    expect(headers[1].authorization).toBeUndefined();
  });
});
