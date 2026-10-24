import { describe, expect, it } from "vitest";
import { hash } from "../agent-runtime/contracts.mjs";
import { gitBlob } from "../agent-runtime/patch.mjs";
import { proposalMarker } from "../agent-runtime/proposals.mjs";
import {
  writePreparedProposal,
  writeProposal,
} from "../agent-runtime/writer.mjs";

const branch = "automation/agent-runtime/codex/012345abcdef";
const root = (version: string) =>
  JSON.stringify({
    dependencies: { "@openai/codex": version, "@cursor/sdk": "1.0.0" },
    codexProtocolVersion: version,
    scripts: { test: "vitest" },
  });
const lock = (version: string, cursor = "1.0.0") =>
  `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '@openai/codex':\n        specifier: ${version}\n        version: ${version}\n      '@cursor/sdk':\n        specifier: ${cursor}\n        version: ${cursor}\npackages: {}\nsnapshots: {}\n`;
function fixture() {
  let remote = "a".repeat(40);
  let labels: any[] = [];
  let race = false;
  let recovered: { git: any; signed: any } | null = null;
  const calls: any[] = [];
  const taskBase = {
    schema: 1,
    provider: "codex",
    from: "1.0.0",
    version: "1.1.0",
    head: remote,
    main: "b".repeat(40),
    automation: "c".repeat(40),
    branch,
    pr: 42,
    lastBotCommit: "d".repeat(40),
    regenerate: false,
    createdAt: "2026-10-12T12:00:00.000Z",
  };
  const task = { ...taskBase, id: hash(taskBase) };
  const contents: any = {
    "package.json": root("1.0.0"),
    "pnpm-lock.yaml": lock("1.0.0"),
    "adapter.ts": "the maintainer's implementation",
  };
  const tree = Object.entries(contents).map(([path, text]) => ({
    path,
    sha: gitBlob(text),
    type: "blob",
    mode: "100644",
  }));
  const patch = {
    schema: 1,
    taskId: task.id,
    provider: task.provider,
    head: task.head,
    version: task.version,
    files: [
      {
        path: "package.json",
        beforeBlob: gitBlob(contents["package.json"]),
        after: root("1.1.0"),
      },
      {
        path: "pnpm-lock.yaml",
        beforeBlob: gitBlob(contents["pnpm-lock.yaml"]),
        after: lock("1.1.0"),
      },
    ],
  };
  const github = {
    async get(path: string) {
      if (path.startsWith("/pulls/"))
        return {
          state: "open",
          number: 42,
          labels,
          base: { ref: "main" },
          user: { type: "Bot", login: "runtime-updater[bot]" },
          body: proposalMarker("codex", branch),
          head: {
            sha: remote,
            ref: branch,
            repo: { full_name: "Withso/zeros" },
          },
        };
      if (path.startsWith("/git/trees/"))
        return { sha: "e".repeat(40), tree, truncated: false };
      if (path.startsWith("/git/ref/")) return { object: { sha: remote } };
      if (recovered && path.startsWith("/git/commits/")) return recovered.git;
      if (recovered && path.startsWith("/commits/")) return recovered.signed;
      throw new Error(`unexpected ${path}`);
    },
    async pages(path: string) {
      calls.push({ method: "GET", path });
      return [];
    },
    async file(path: string) {
      return contents[path];
    },
    async post(path: string, body: any) {
      calls.push({ method: "POST", path, body });
      if (path === "/git/blobs") return { sha: gitBlob(body.content) };
      if (path === "/git/trees") return { sha: "f".repeat(40) };
      if (path === "/git/commits") return { sha: "1".repeat(40) };
      if (path === "/pulls") return { number: 42 };
      if (path === "/issues/42/labels") return [];
      throw new Error(`unexpected ${path}`);
    },
    async patch(path: string, body: any) {
      calls.push({ method: "PATCH", path, body });
      if (race) {
        remote = "9".repeat(40);
        const error: any = new Error("non-fast-forward");
        error.status = 422;
        throw error;
      }
      remote = body.sha;
      return { object: { sha: remote } };
    },
    async mergeState() {
      return { mergeQueueEntry: null, auto_merge: null };
    },
    async delete(path: string) {
      calls.push({ method: "DELETE", path });
      labels = labels.filter(
        (label) => label.name !== "agent-runtime:regenerate",
      );
    },
  };
  return {
    github,
    task,
    patch,
    calls,
    contents,
    tree,
    requestRegeneration: () => {
      labels = [{ name: "agent-runtime:regenerate" }];
    },
    withdrawRegeneration: () => {
      labels = [];
    },
    remote: () => remote,
    race: () => {
      race = true;
    },
    hold: () => {
      labels = [{ name: "agent-runtime:hold" }];
    },
    move: () => {
      remote = "9".repeat(40);
    },
    recover: (evidence: { git: any; signed: any }) => {
      recovered = evidence;
    },
  };
}
function regeneration() {
  const f = fixture();
  const { id: _id, ...base } = f.task;
  const identity = {
    ...base,
    version: base.from,
    regenerate: true,
    lastBotCommit: base.head,
  };
  const task = { ...identity, id: hash(identity) };
  f.requestRegeneration();
  return {
    ...f,
    task,
    patch: { ...f.patch, taskId: task.id, version: task.version, files: [] },
  };
}

describe("interrupted first write recovery", () => {
  function interrupted() {
    const f = fixture();
    const { id: _id, ...base } = f.task;
    const identity = { ...base, pr: null, lastBotCommit: null };
    const task = { ...identity, id: hash(identity) };
    const sha = f.remote();
    const git = {
      sha,
      message: `Update Codex runtime to 1.1.0\n\nZeros-Runtime-Task: ${task.id}\nZeros-Runtime-Provider: codex`,
      parents: [{ sha: task.head }],
    };
    // The shape GitHub returned for the App's hosted commit on #714.
    const signed = {
      sha,
      author: { type: "Bot", login: "runtime-updater[bot]" },
      committer: { type: "User", login: "web-flow" },
      commit: {
        message: git.message,
        verification: { verified: true, reason: "valid" },
      },
    };
    return { ...f, task, patch: { ...f.patch, taskId: task.id }, git, signed };
  }
  it("reuses the GitHub-signed App commit left by an interrupted first run", async () => {
    const f = interrupted();
    f.recover({ git: f.git, signed: f.signed });
    const result = await writeProposal({ ...f, appSlug: "runtime-updater" });
    expect(result).toMatchObject({
      status: "written",
      pr: 42,
      head: f.git.sha,
    });
    expect(f.calls.some((call) => call.path === "/git/commits")).toBe(false);
    expect(f.calls.some((call) => call.path === "/pulls")).toBe(true);
  });
  it("refuses a recovered branch commit that GitHub did not sign for the App", async () => {
    for (const signed of [
      (f: any) => ({
        ...f.signed,
        author: { type: "User", login: "maintainer" },
      }),
      (f: any) => ({
        ...f.signed,
        committer: { type: "User", login: "maintainer" },
      }),
      (f: any) => ({
        ...f.signed,
        commit: { ...f.signed.commit, verification: { verified: false } },
      }),
    ]) {
      const f = interrupted();
      f.recover({ git: f.git, signed: signed(f) });
      await expect(
        writeProposal({ ...f, appSlug: "runtime-updater" }),
      ).rejects.toThrow("manual reconciliation");
      expect(f.calls.some((call) => call.method === "POST")).toBe(false);
    }
  });
});

describe("trusted runtime branch writer", () => {
  it("appends to the human head, updates the same PR and never force-pushes", async () => {
    const f = fixture();
    const result = await writeProposal({ ...f, appSlug: "runtime-updater" });
    expect(result).toMatchObject({ status: "written", pr: 42 });
    expect(
      f.calls.find((call) => call.path === "/git/commits").body.parents,
    ).toEqual([f.task.head]);
    expect(
      f.calls.find((call) => call.path === "/git/trees").body.base_tree,
    ).toBe("e".repeat(40));
    expect(f.calls.find((call) => call.method === "PATCH").body.force).toBe(
      false,
    );
    expect(f.calls.some((call) => call.path === "/pulls")).toBe(false);
    expect(f.contents["adapter.ts"]).toBe("the maintainer's implementation");
  });
  it("lets a concurrent human push win even after the last head check", async () => {
    const f = fixture();
    f.race();
    expect(
      (await writeProposal({ ...f, appSlug: "runtime-updater" })).status,
    ).toBe("stale-head");
    expect(f.remote()).toBe("9".repeat(40));
  });
  it("does not write when a freeze or newer head is already visible", async () => {
    for (const action of ["hold", "move"] as const) {
      const f = fixture();
      f[action]();
      expect(
        (await writeProposal({ ...f, appSlug: "runtime-updater" })).status,
      ).toBe(action === "hold" ? "held" : "stale-head");
      expect(f.calls).toHaveLength(0);
    }
  });
  it("rejects workflow, symlink/path traversal, duplicate and wrong-base output", async () => {
    for (const file of [
      { path: ".github/workflows/ci.yml", beforeBlob: null, after: "bad" },
      {
        path: "apps/desktop/src/engine/agents/adapters/codex/generated/../../index.ts",
        beforeBlob: null,
        after: "bad",
      },
      { path: "package.json", beforeBlob: null, after: root("1.1.0") },
    ]) {
      const f = fixture();
      f.patch.files.push(file);
      await expect(
        writeProposal({ ...f, appSlug: "runtime-updater" }),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });
  it("rejects unrelated manifest commands and other provider lockfile changes", async () => {
    const f = fixture();
    f.patch.files[0].after = root("1.1.0").replace(
      "vitest",
      "untrusted command",
    );
    await expect(
      writeProposal({ ...f, appSlug: "runtime-updater" }),
    ).rejects.toThrow("unrelated manifest");
    f.patch.files[0].after = root("1.1.0");
    f.patch.files[1].after = lock("1.1.0", "2.0.0");
    await expect(
      writeProposal({ ...f, appSlug: "runtime-updater" }),
    ).rejects.toThrow("another dependency");
    expect(f.calls).toHaveLength(0);
  });
  it("acknowledges unchanged regeneration with an App task commit on the identical tree", async () => {
    const f = regeneration();
    const result = await writeProposal({ ...f, appSlug: "runtime-updater" });
    expect(result).toMatchObject({
      status: "written",
      pr: 42,
      head: "1".repeat(40),
    });
    expect(
      f.calls.filter((call) =>
        ["/git/trees", "/git/blobs"].includes(call.path),
      ),
    ).toEqual([]);
    const committed = f.calls.find((call) => call.path === "/git/commits");
    expect(committed.body).toMatchObject({
      tree: "e".repeat(40),
      parents: [f.task.head],
    });
    expect(committed.body.message).toContain(
      `Zeros-Runtime-Task: ${f.task.id}`,
    );
    expect(f.calls.find((call) => call.method === "PATCH").body).toEqual({
      sha: result.head,
      force: false,
    });
    const deletion = f.calls.findIndex((call) => call.method === "DELETE");
    expect(deletion).toBeGreaterThan(
      f.calls.findIndex((call) => call.method === "PATCH"),
    );
    expect(f.calls[deletion].path).toBe(
      "/issues/42/labels/agent-runtime%3Aregenerate",
    );
  });
  it("routes an unchanged preparation through the same validated writer as file changes", async () => {
    const f = regeneration();
    const report = {
      schema: 1,
      head: f.task.head,
      testedHead: null,
      gates: [],
      changes: [],
    };
    const prepared = { status: "unchanged", patch: f.patch, report };
    const result = await writePreparedProposal({
      ...f,
      prepared,
      appSlug: "runtime-updater",
    });
    expect(result).toMatchObject({
      status: "written",
      head: "1".repeat(40),
      report,
    });
    const blocked = regeneration();
    expect(
      await writePreparedProposal({
        ...blocked,
        prepared: { status: "blocked" },
        appSlug: "runtime-updater",
      }),
    ).toMatchObject({ status: "preparation-blocked" });
    expect(blocked.calls).toEqual([]);
    await expect(
      writePreparedProposal({
        ...blocked,
        prepared: { status: "unchanged", report },
        appSlug: "runtime-updater",
      }),
    ).rejects.toThrow("empty patch");
    expect(blocked.calls).toEqual([]);
  });
  it("limits empty patches to explicitly requested regeneration at the same pin and head", async () => {
    for (const controls of [
      { regenerate: false },
      { pr: null },
      { version: "1.1.0" },
      { lastBotCommit: "d".repeat(40) },
    ]) {
      const f = regeneration();
      const { id: _id, ...base } = f.task;
      const identity = { ...base, ...controls };
      const task = { ...identity, id: hash(identity) };
      await expect(
        writeProposal({
          ...f,
          task,
          patch: { ...f.patch, taskId: task.id, version: task.version },
          appSlug: "runtime-updater",
        }),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
    const f = regeneration();
    f.withdrawRegeneration();
    expect(
      (await writeProposal({ ...f, appSlug: "runtime-updater" })).status,
    ).toBe("preparation-blocked");
    expect(f.calls).toEqual([]);
  });
  it("validates the existing manifest and lockfile before acknowledging an empty patch", async () => {
    for (const file of ["package.json", "pnpm-lock.yaml"]) {
      const f = regeneration();
      f.contents[file] =
        file === "package.json" ? root("1.1.0") : lock("1.1.0");
      await expect(
        writeProposal({ ...f, appSlug: "runtime-updater" }),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
    const f = regeneration();
    f.tree.find((entry) => entry.path === "package.json")!.mode = "120000";
    await expect(
      writeProposal({ ...f, appSlug: "runtime-updater" }),
    ).rejects.toThrow("regular file");
    expect(f.calls).toEqual([]);
  });
  it("keeps hold and concurrent-push protection on unchanged regeneration", async () => {
    for (const action of ["hold", "move", "race"] as const) {
      const f = regeneration();
      f[action]();
      const result = await writeProposal({ ...f, appSlug: "runtime-updater" });
      expect(result.status).toBe(action === "hold" ? "held" : "stale-head");
      expect(f.calls.some((call) => call.method === "DELETE")).toBe(false);
      if (action === "move" || action === "race")
        expect(f.remote()).toBe("9".repeat(40));
    }
  });
  it("rechecks regeneration permission and holds immediately before updating the ref", async () => {
    for (const action of ["hold", "withdrawRegeneration"] as const) {
      const f = regeneration();
      const post = f.github.post;
      f.github.post = async (path, body) => {
        const result = await post(path, body);
        if (path === "/git/commits") f[action]();
        return result;
      };
      expect(
        (await writeProposal({ ...f, appSlug: "runtime-updater" })).status,
      ).toBe(action === "hold" ? "held" : "preparation-blocked");
      expect(
        f.calls.some((call) => ["PATCH", "DELETE"].includes(call.method)),
      ).toBe(false);
      expect(f.remote()).toBe(f.task.head);
    }
  });
});
