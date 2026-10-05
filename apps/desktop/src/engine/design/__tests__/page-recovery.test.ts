import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesignFrame, createDesignPage, deleteDesignPage, initializeDesignDocument } from "../document";
import { withDesignDirectoryNameLease } from "../directory-registry";
import { designPrivateStorageDirectory, recoverWorkspaceDesignMetadata } from "../metadata";

const fault = vi.hoisted(() => ({ kind: "write" as "write" | "delete", target: "" }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const fail = (kind: typeof fault.kind, target: unknown) => {
    if (fault.kind === kind && fault.target === String(target)) {
      fault.target = "";
      throw new Error("Simulated page-delete crash");
    }
  };
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => { fs.renameSync(...args); fail("write", args[1]); },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => { fs.unlinkSync(...args); fail("delete", args[0]); },
  };
});

describe("journaled page deletion recovery", () => {
  let root: string;
  const directory = "Product - Design";
  const run = <T>(action: () => Promise<T>) => withDesignDirectoryNameLease(root, directory, action);
  const readCanvas = () => JSON.parse(readFileSync(path.join(root, directory, "meta/canvas.json"), "utf8"));
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-page-delete-recovery-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    await run(() => initializeDesignDocument(root));
  });
  afterEach(() => {
    fault.target = "";
    delete process.env.ZEROS_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["catalog", "first-source", "last-source"] as const)("recovers a crash after the durable %s change without deleting unregistered source", point => run(async () => {
    const page = await createDesignPage(root, { title: "Checkout" });
    const first = await createDesignFrame(root, { pageId: page.id, title: "First" });
    const last = await createDesignFrame(root, { pageId: page.id, title: "Last" });
    const keep = path.join(root, directory, page.folder, "notes.html");
    writeFileSync(keep, "Keep unregistered source");
    const ids = readCanvas().pages.find((candidate: { id: string }) => candidate.id === page.id).frames;
    fault.kind = point === "catalog" ? "write" : "delete";
    fault.target = path.join(root, directory, point === "catalog" ? "meta/canvas.json" : point === "first-source" ? first.file : last.file);
    await expect(deleteDesignPage(root, page.id, ids)).rejects.toThrow("Simulated page-delete crash");
    const journals = () => readdirSync(designPrivateStorageDirectory(root)).filter(name => /^metadata-[a-f0-9]{24}\.json$/.test(name));
    expect(journals()).toHaveLength(1);
    recoverWorkspaceDesignMetadata(root);
    expect(journals()).toEqual([]);
    expect(readCanvas().pages.some((candidate: { id: string }) => candidate.id === page.id)).toBe(false);
    expect(Object.keys(readCanvas().frames)).toEqual([]);
    expect(existsSync(path.join(root, directory, first.file))).toBe(false);
    expect(existsSync(path.join(root, directory, last.file))).toBe(false);
    expect(readFileSync(keep, "utf8")).toBe("Keep unregistered source");
    const after = readFileSync(path.join(root, directory, "meta/canvas.json"));
    recoverWorkspaceDesignMetadata(root);
    expect(readFileSync(path.join(root, directory, "meta/canvas.json"))).toEqual(after);
  }));

  it("retains a concurrent source edit and the recovery record when deletion cannot finish safely", () => run(async () => {
    const page = await createDesignPage(root, { title: "Checkout" });
    const frame = await createDesignFrame(root, { pageId: page.id, title: "Home" });
    const ids = readCanvas().pages.find((candidate: { id: string }) => candidate.id === page.id).frames;
    fault.kind = "write";
    fault.target = path.join(root, directory, "meta/canvas.json");
    await expect(deleteDesignPage(root, page.id, ids)).rejects.toThrow("Simulated page-delete crash");
    writeFileSync(path.join(root, directory, frame.file), "Keep concurrent authoring");
    expect(() => recoverWorkspaceDesignMetadata(root)).toThrow(/source changed|changed during migration/i);
    expect(readFileSync(path.join(root, directory, frame.file), "utf8")).toBe("Keep concurrent authoring");
    expect(readdirSync(designPrivateStorageDirectory(root)).some(name => /^metadata-/.test(name))).toBe(true);
  }));
});
