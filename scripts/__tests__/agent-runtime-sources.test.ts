import { describe, expect, it } from "vitest";
import {
  collectNotes,
  collectRegistry,
  collectReleases,
  driftSummary,
  notesText,
  registrySnapshot,
} from "../agent-runtime/sources.mjs";

const now = "2026-10-12T12:00:00.000Z";
const registry = () => ({
  "dist-tags": { latest: "1.3.0", next: "2.0.0-beta.1" },
  time: {
    "1.0.0": "2026-10-01T00:00:00.000Z",
    "1.1.0": "2026-10-09T00:00:00.000Z",
    "1.2.0": "2026-10-10T00:00:00.000Z",
    "1.3.0": "2026-10-12T00:00:00.000Z",
  },
  versions: {
    "1.0.0": {},
    "1.1.0": {},
    "1.2.0": {},
    "1.3.0": {},
    "2.0.0-beta.1": {},
  },
});

describe("public runtime sources", () => {
  it("collects every stable release since the shipping pin, with a separate eligible candidate", () => {
    const result = registrySnapshot(registry(), "1.0.0", now);
    expect(result.versions.map((v: any) => v.version)).toEqual([
      "1.0.0",
      "1.1.0",
      "1.2.0",
      "1.3.0",
    ]);
    expect(result.latest).toBe("1.3.0");
    expect(result.candidate).toBe("1.2.0");
  });
  it("does not manufacture publication times or select a deprecated release", () => {
    const metadata: any = registry();
    metadata.versions["1.2.0"].deprecated = "withdrawn";
    expect(registrySnapshot(metadata, "1.0.0", now).candidate).toBe("1.1.0");
    delete metadata.time["1.1.0"];
    expect(() => registrySnapshot(metadata, "1.0.0", now)).toThrow(
      "publication time",
    );
  });
  it("does not infer Claude's embedded CLI version from its wrapper number", async () => {
    const value: any = registry();
    const result = await collectRegistry("claude", "1.0.0", now, {
      fetchImpl: async () => Response.json(value),
    });
    expect(result.status).toBe("incomplete");
  });
  it("represents a registry failure as incomplete, never all up to date", async () => {
    const result = await collectRegistry("codex", "1.0.0", now, {
      fetchImpl: async () => new Response(null, { status: 429 }),
    });
    expect(result.status).toBe("incomplete");
    expect(
      driftSummary([{ status: "unavailable" }, { status: "unavailable" }]),
    ).toContain("incomplete");
    expect(driftSummary([])).toContain("unavailable");
    expect(
      driftSummary([{ status: "current" }, { status: "unavailable" }]),
    ).not.toContain("All");
    expect(driftSummary([{ status: "ahead" }])).toContain("rollback");
  });
  it("normalizes release notes without script/build payloads or navigation", () => {
    const document = `<nav>changes every deployment</nav><main><h1>Cursor SDK release notes</h1><p>New model capabilities and host-interactive approval callbacks are now documented.</p><script>untrusted()</script></main>`;
    expect(notesText(document)).not.toMatch(/untrusted|deployment/);
  });
  it("revalidates the exact last-good notes on 304 and fails without that snapshot", async () => {
    const source = {
      id: "cursor-sdk-notes",
      provider: "cursor",
      url: "https://cursor.com/docs/release-notes/sdk",
      advisory: false,
    };
    const fetchImpl = async () => new Response(null, { status: 304 });
    expect(
      (await collectNotes(source, now, undefined, { fetchImpl })).status,
    ).toBe("incomplete");
    const previous = { etag: "fixture", data: { digest: "abc", watches: [] } };
    expect(
      (await collectNotes(source, now, previous, { fetchImpl })).data,
    ).toEqual(previous.data);
  });
  it("handles rust-v release tags and keeps GitHub announcements separate from installability", async () => {
    const result = await collectReleases("codex", "1.0.0", now, {
      fetchImpl: async () =>
        Response.json([
          {
            tag_name: "rust-v1.1.0",
            published_at: now,
            body: "A new model is available",
            prerelease: false,
            draft: false,
          },
        ]),
    });
    expect(result.status).toBe("complete");
    expect(result.data.releases[0].version).toBe("1.1.0");
    expect(result.data.installable).toBeUndefined();
  });
  it("reports partial pagination as incomplete instead of dropping older releases", async () => {
    let pages = 0;
    const result = await collectReleases("codex", "1.0.0", now, {
      fetchImpl: async () =>
        ++pages === 1
          ? Response.json(
              Array.from({ length: 100 }, () => ({
                tag_name: "rust-v2.0.0",
                published_at: now,
                body: "Release",
                prerelease: false,
              })),
            )
          : new Response(null, { status: 503 }),
    });
    expect(result.status).toBe("incomplete");
  });
  it("accepts the current Codex metadata size while bounding release pages", async () => {
    const metadata = { ...registry(), readme: "x".repeat(17 * 1024 * 1024) };
    expect(
      (
        await collectRegistry("codex", "1.0.0", now, {
          fetchImpl: async () => Response.json(metadata),
        })
      ).status,
    ).toBe("complete");
    const releases = await collectReleases("codex", "1.0.0", now, {
      fetchImpl: async (url: string) =>
        new URL(url).searchParams.get("per_page") === "20"
          ? Response.json([
              {
                tag_name: "rust-v1.0.0",
                published_at: now,
                body: "Stable SDK release",
                draft: false,
                prerelease: false,
              },
            ])
          : new Response(null, { status: 413 }),
    });
    expect(releases.status).toBe("complete");
  });
});
