// A sandboxed shell (Codex workspace-write) cannot open the CLI's loopback
// connection but may write under $TMPDIR. The engine serves each admitted
// execution a private drop folder there: request in, envelope out.

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { localOk } from "@zeros/protocol/local-orchestration";
import { LocalDropbox, LOCAL_DROPBOX_REQUEST } from "../dropbox";
import { LocalCapabilityRegistry, type LocalCallHandler } from "../server";
import type { LocalCallerScope } from "../types";

const roots: string[] = [];
const dropboxes: LocalDropbox[] = [];
afterEach(async () => {
  for (const dropbox of dropboxes.splice(0)) await dropbox.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(handler: LocalCallHandler = async (scope, body) => localOk({ scope, body }, { engine: "e" })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-dropbox-test-"));
  roots.push(root);
  const registry = new LocalCapabilityRegistry();
  const dropbox = new LocalDropbox(registry, handler, () => "engine-1", { root, sweepMs: 10 });
  dropboxes.push(dropbox);
  return { registry, dropbox, root };
}

async function exchange(dir: string, token: string, body: unknown): Promise<unknown> {
  const id = "a".repeat(24);
  fs.writeFileSync(path.join(dir, `${id}.req.tmp`), JSON.stringify({ protocol: 1, token, body }), { mode: 0o600 });
  fs.renameSync(path.join(dir, `${id}.req.tmp`), path.join(dir, `${id}${LOCAL_DROPBOX_REQUEST}`));
  for (let i = 0; i < 200; i++) {
    const res = path.join(dir, `${id}.res`);
    if (fs.existsSync(res)) return JSON.parse(fs.readFileSync(res, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no response");
}

describe("Local CLI drop folder", () => {
  const scope: LocalCallerScope = { executionId: "exec-1", chatId: "chat-1", agentId: "codex", surface: "cli" };

  it("answers a request in a private per-execution folder and removes it on close", async () => {
    const { registry, dropbox } = setup();
    const token = registry.mint(scope);
    const box = await dropbox.open(scope);
    expect((fs.statSync(box.dir).mode & 0o777).toString(8)).toBe("700");
    const envelope = await exchange(box.dir, token, { protocol: 1, command: "whoami", args: {} });
    expect(envelope).toMatchObject({ ok: true, result: { scope: { executionId: "exec-1", surface: "cli" }, body: { command: "whoami" } } });
    await box.close();
    expect(fs.existsSync(box.dir)).toBe(false);
  });

  it("refuses a capability that belongs to another execution or was revoked", async () => {
    const { registry, dropbox } = setup();
    const other = registry.mint({ ...scope, executionId: "exec-2" });
    const box = await dropbox.open(scope);
    expect(await exchange(box.dir, other, { protocol: 1, command: "whoami", args: {} })).toMatchObject({ ok: false, error: { code: "NO_CAPABILITY" } });
    const mine = registry.mint(scope);
    registry.revoke(mine);
    fs.rmSync(path.join(box.dir, `${"a".repeat(24)}.res`));
    expect(await exchange(box.dir, mine, { protocol: 1, command: "whoami", args: {} })).toMatchObject({ ok: false, error: { code: "NO_CAPABILITY" } });
    await box.close();
  });

  it("ignores files it did not ask for", async () => {
    const { registry, dropbox } = setup();
    registry.mint(scope);
    const box = await dropbox.open(scope);
    fs.writeFileSync(path.join(box.dir, "notes.txt"), "hello");
    fs.writeFileSync(path.join(box.dir, "../escape.req"), "{}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.readdirSync(box.dir)).toEqual(["notes.txt"]);
    await box.close();
  });

  it.each(["symlink", "hard link"])("never overwrites an outside file through a response temporary %s", async (kind) => {
    const { registry, dropbox, root } = setup();
    const token = registry.mint(scope);
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "must remain unchanged");
    const box = await dropbox.open(scope);
    const temporary = path.join(box.dir, `${"a".repeat(24)}.res.tmp`);
    if (kind === "symlink") fs.symlinkSync(outside, temporary);
    else fs.linkSync(outside, temporary);
    expect(await exchange(box.dir, token, { protocol: 1, command: "whoami", args: {} })).toMatchObject({ ok: true });
    expect(fs.readFileSync(outside, "utf8")).toBe("must remain unchanged");
  });

  it("refuses an engine drop root that was replaced by a symlink", async () => {
    const { registry, dropbox, root } = setup();
    const outside = `${root}-outside`;
    roots.push(outside);
    fs.mkdirSync(outside);
    fs.rmSync(root, { recursive: true });
    fs.symlinkSync(outside, root);
    registry.mint(scope);
    await expect(dropbox.open(scope)).rejects.toBeDefined();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("closes a box while a request is pending without publishing a late response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = vi.fn(async () => { await gate; return localOk({ done: true }, { engine: "e" }); });
    const { registry, dropbox } = setup(handler);
    const token = registry.mint(scope);
    const box = await dropbox.open(scope);
    const liveBox = [...dropbox["boxes"]][0]!;
    const id = "c".repeat(24);
    liveBox.active.add(id);
    fs.writeFileSync(path.join(box.dir, `${id}.req`), JSON.stringify({ token, body: { command: "whoami", args: {} } }));
    const serving = dropbox["serve"](liveBox, id);
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      await box.close();
      expect(liveBox.controller.signal.aborted).toBe(true);
      expect(fs.existsSync(box.dir)).toBe(false);
    } finally {
      release();
      await serving;
    }
    expect(fs.existsSync(box.dir)).toBe(false);
  });

  it("never publishes or removes host files after the writable drop directory is redirected", async () => {
    const { registry, dropbox, root } = setup();
    const token = registry.mint(scope);
    const box = await dropbox.open(scope);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const id = "b".repeat(24);
    const response = path.join(outside, `${id}.res`);
    fs.writeFileSync(response, "must remain unchanged");
    const original = `${box.dir}-original`;
    // Hold the handler, redirect its directory, then let publication finish.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = vi.spyOn(dropbox as unknown as { handler: (caller: LocalCallerScope, body: unknown) => Promise<unknown> }, "handler")
      .mockImplementation(async () => { await gate; return localOk({ done: true }, { engine: "e" }); });
    const liveBox = [...dropbox["boxes"]][0]!;
    // Drive one claim directly so completion is observable without a timer race.
    fs.writeFileSync(path.join(box.dir, `${id}.req`), JSON.stringify({ protocol: 1, token, body: { command: "whoami", args: {} } }));
    liveBox.active.add(id);
    const serving = dropbox["serve"](liveBox, id);
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      fs.renameSync(box.dir, original);
      fs.symlinkSync(outside, box.dir);
    } finally {
      release();
      await serving;
      handler.mockRestore();
    }
    expect(fs.readFileSync(response, "utf8")).toBe("must remain unchanged");
    await box.close();
    expect(fs.readFileSync(response, "utf8")).toBe("must remain unchanged");
    expect(fs.readdirSync(outside)).toEqual([`${id}.res`]);
  });
});
