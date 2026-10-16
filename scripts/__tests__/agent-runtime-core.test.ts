import { describe, expect, it } from "vitest";
import {
  compareVersions,
  hash,
  markdown,
  parseJson,
  validateTask,
} from "../agent-runtime/contracts.mjs";
import { managedPath } from "../agent-runtime/config.mjs";
import { publicFetch, publicUrl } from "../agent-runtime/network.mjs";

describe("runtime automation input boundaries", () => {
  it("sorts stable versions numerically and rejects ranges/prerelease noise", () => {
    expect(compareVersions("0.162.1", "0.99.9")).toBe(1);
    expect(() => compareVersions("^1.2.3", "1.2.3")).toThrow();
    expect(() => compareVersions("1.2.3-alpha.1", "1.2.3")).toThrow();
    expect(hash({ b: 1, a: 2 })).toBe(hash({ a: 2, b: 1 }));
  });
  it("does not grant generated-file ownership to paths outside the exact scope", () => {
    expect(
      managedPath(
        "codex",
        "apps/desktop/src/engine/agents/adapters/codex/generated/v2/Model.ts",
      ),
    ).toBe(true);
    for (const file of [
      ".github/workflows/ci.yml",
      "apps/control-plane/package.json",
      "catalogs/models-v1.json",
      "apps/desktop/src/engine/agents/adapters/codex/generated/../../index.ts",
    ])
      expect(managedPath("codex", file)).toBe(false);
    expect(
      managedPath(
        "cursor",
        "apps/desktop/src/engine/agents/adapters/codex/generated/.version",
      ),
    ).toBe(false);
  });
  it("bounds JSON and neutralizes upstream Markdown and mentions", () => {
    expect(() => parseJson('{"__proto__": {}}')).toThrow();
    expect(() => parseJson('"long"', 2)).toThrow();
    expect(markdown("@everyone <script> [click](bad)\nnext")).not.toContain(
      "@everyone",
    );
  });
  it("binds tasks to exact heads and forbids an automatic downgrade", () => {
    const task = {
      schema: 1,
      provider: "codex",
      from: "0.162.1",
      version: "0.162.2",
      head: "a".repeat(40),
      main: "b".repeat(40),
      automation: "c".repeat(40),
      branch: "automation/agent-runtime/codex/012345abcdef",
      pr: 42,
      lastBotCommit: null,
      regenerate: false,
      createdAt: "2026-10-12T00:00:00.000Z",
    };
    expect(validateTask({ ...task, id: hash(task) }).pr).toBe(42);
    expect(() =>
      validateTask({ ...task, head: "d".repeat(40), id: hash(task) }),
    ).toThrow();
    const downgrade = { ...task, version: "0.161.0" };
    expect(() => validateTask({ ...downgrade, id: hash(downgrade) })).toThrow();
  });
  it("rejects credential-bearing or internal source URLs before fetching", () => {
    for (const url of [
      "http://registry.npmjs.org/x",
      "https://127.0.0.1/x",
      "https://api.github.com.evil.test/x",
      "https://user@api.github.com/x",
    ])
      expect(() => publicUrl(url)).toThrow();
  });
  it("never forwards a GitHub token to an allowlisted redirect host", async () => {
    const requests: any[] = [];
    const fetchImpl = async (url: string, options: any) => {
      requests.push({ url, ...options });
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://cursor.com/docs" },
          })
        : new Response("notes");
    };
    expect(
      (
        await publicFetch("https://api.github.com/repos/x/y", {
          token: "test-placeholder",
          fetchImpl,
        })
      ).text,
    ).toBe("notes");
    expect(requests[0].headers.authorization).toBeDefined();
    expect(requests[1].headers.authorization).toBeUndefined();
  });
  it("stops a response that exceeds its streaming budget", async () => {
    await expect(
      publicFetch("https://cursor.com/docs", {
        maximum: 3,
        fetchImpl: async () => new Response("too large"),
      }),
    ).rejects.toThrow("size limit");
  });
  it("does not acquire GitHub credentials when a public source redirects into the API", async () => {
    const headers: any[] = [];
    await publicFetch("https://cursor.com/docs", {
      token: "test-placeholder",
      fetchImpl: async (_: string, options: any) => {
        headers.push(options.headers);
        return headers.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://api.github.com/user" },
            })
          : new Response("fixture");
      },
    });
    expect(headers.every((value) => value.authorization === undefined)).toBe(
      true,
    );
  });
});
