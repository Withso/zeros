import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeState, setStateRootForTesting } from "../../git";
import { insertWorkspace } from "../../git/state";
import { WorkspaceService } from "../service";
import { resetWorkspaceDesignApisForTests } from "../../design/design-api";
import { resetDesignComponentRendersForTests } from "../../design/component-last-good";

const FIXTURE = path.join(__dirname, "fixtures/design-components");
const params = { workspaceId: "local-main" };
const options = { hostLocalResources: false };
type Frame = { file: string; sourceVersion: string; srcDoc?: string; instances?: { hosts: Record<string, Record<string, unknown>> } };
type Violation = { ruleId: string; severity: string; file: string; line: number; oid?: string; message: string };

describe("the committed component fixture through WorkspaceService", () => {
  let root: string;
  let service: WorkspaceService;
  const call = (op: string, extra: Record<string, unknown> = {}) => service.handle(op, { ...params, ...extra }, options) as Promise<any>;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const read = (file: string) => readFileSync(path.join(root, "design", file), "utf8");
  const frame = async (file: string, variant?: string) =>
    ((await call("design.frame", { frame: file, ...(variant ? { variant } : {}) })) as { frame: Frame }).frame;
  const apply = async (file: string, id: string, operations: Array<Record<string, unknown>>) => {
    const opened = await call("design.foundation.open", { frame: file });
    const result = await call("design.transaction.apply", {
      frame: file,
      transaction: {
        schemaVersion: 1, transactionId: id, documentId: opened.summary.documentId, baseRevision: opened.summary.revision,
        actor: { kind: "human", id: "desktop" }, intent: id, createdAt: 1,
        operations: operations.map((operation, index) => ({ operationId: `${id}-${index}`, ...operation })),
      },
    });
    expect(result.result.receipt.status).toBe("applied");
    return result;
  };
  const lint = async () => ((await call("design.lint")) as { report: { violations: Violation[] } }).report.violations;

  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-components-"));
    await cp(FIXTURE, root, { recursive: true });
    setStateRootForTesting(path.join(root, "state"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("add", ".");
    git("commit", "-qm", "Fixture");
    service = new WorkspaceService(root);
    insertWorkspace(service["localMainEntry"]());
    await call("design.initialize");
  });
  afterEach(async () => {
    resetWorkspaceDesignApisForTests();
    closeState();
    await rm(root, { recursive: true, force: true });
  });

  it("prepares the main and its host, and expands each instance with its values or the defaults", async () => {
    // Navigation and preparation run where local resources are hosted.
    const navigation = await service.handle("design.navigation.read", params) as { directoryId: string; catalogRevision: string };
    const prepared = await service.handle("design.frames.prepare", {
      ...params, directoryId: navigation.directoryId, catalogRevision: navigation.catalogRevision,
      files: ["library/chip.html", "screens/hosts.html"], componentOptions: true,
    }) as { frames: Array<Frame & { component?: { reach: Record<string, string> } }>; errors: unknown[] };
    expect(prepared.errors).toEqual([]);
    const [main, host] = prepared.frames;
    expect(main!.component!.reach).toEqual({ width: "css", accent: "css", label: "structure", tone: "structure", motion: "css" });
    expect(host!.instances!.hosts).toEqual({
      "inst-set": { component: "fx-chip", attributes: { label: "Hello", width: "200", tone: "loud" } },
      "inst-ignored": { component: "fx-chip", attributes: {}, ignored: { shape: "round" } },
    });
    const shown = (await frame("screens/hosts.html")).srcDoc!;
    expect(shown).toContain('<b data-zd-part="chip-label">Hello</b>');
    expect(shown).toContain('data-tone="loud"');
    expect(shown).toContain('<b data-zd-part="chip-label">Chip</b>');
    // The derived pad follows each instance's width.
    expect(shown).toMatch(/--zd-width: 200px;[^}]*--zd-pad: 20px;/);
    expect(shown).toMatch(/--zd-width: 160px;[^}]*--zd-pad: 16px;/);
    // The legacy components/ definition expands too, with its attribute slot.
    expect(shown).toContain('<span data-zid="badge" class="badge">New</span>');
    // The ignored attribute is reported at the instance that carries it.
    expect(await lint()).toEqual([expect.objectContaining({
      ruleId: "component-value-invalid", severity: "warning", file: "screens/hosts.html", line: 11, oid: "inst-ignored",
    })]);
  });

  it("shows each variant of the main under the main's own source version", async () => {
    const plain = await frame("library/chip.html");
    const compact = await frame("library/chip.html", "compact");
    expect(compact.sourceVersion).toBe(plain.sourceVersion);
    expect(compact.srcDoc).toContain("--zd-width: 96px");
    expect(compact.srcDoc).toContain(">Small</b>");
    expect((await frame("library/chip.html", "loud")).srcDoc).toContain('data-tone="loud"');
    expect(plain.srcDoc).toContain("--zd-width: 160px");
  });

  it("writes an instance value and a main default as one line each; undo and redo return the exact bytes and source versions", async () => {
    const host0 = read("screens/hosts.html");
    const main0 = read("library/chip.html");
    const canvas0 = read("meta/canvas.json");
    const hostVersion0 = (await frame("screens/hosts.html")).sourceVersion;
    const mainVersion0 = (await frame("library/chip.html")).sourceVersion;

    await apply("screens/hosts.html", "instance-width", [{ type: "node.set-attribute", nodeId: "inst-set", attribute: "width", value: "240" }]);
    const host1 = read("screens/hosts.html");
    expect(host1).toBe(host0.replace('width="200"', 'width="240"'));
    const hostVersion1 = (await frame("screens/hosts.html")).sourceVersion;
    expect(hostVersion1).not.toBe(hostVersion0);
    expect((await frame("screens/hosts.html")).srcDoc).toMatch(/--zd-width: 240px;[^}]*--zd-pad: 24px;/);

    await apply("library/chip.html", "main-width", [{ type: "component.set-option", file: "library/chip.html", option: "width", variant: null, value: 120 }]);
    expect(read("library/chip.html")).toBe(main0.replace('default="160"', 'default="120"'));
    expect((await frame("screens/hosts.html")).srcDoc).toMatch(/--zd-width: 120px;[^}]*--zd-pad: 12px;/);

    // The scene write keeps the file's escapes, inline arrays and key order,
    // and only appends the foundation registering the legacy component.
    const canvas1 = read("meta/canvas.json");
    expect(canvas1.startsWith(canvas0.slice(0, -"\n}\n".length))).toBe(true);
    expect(JSON.parse(canvas1).foundation.components).toEqual([expect.objectContaining({ id: "fx-badge", file: "components/fx-badge.html" })]);

    await call("design.history.undo");
    expect(read("library/chip.html")).toBe(main0);
    expect((await frame("library/chip.html")).sourceVersion).toBe(mainVersion0);
    await call("design.history.undo");
    expect(read("screens/hosts.html")).toBe(host0);
    expect((await frame("screens/hosts.html")).sourceVersion).toBe(hostVersion0);
    await call("design.history.redo");
    expect(read("screens/hosts.html")).toBe(host1);
    expect((await frame("screens/hosts.html")).sourceVersion).toBe(hostVersion1);
  });

  it("deletes and reorders layers alone on their lines without leaving blank or shared lines", async () => {
    const host0 = read("screens/hosts.html");
    await apply("screens/hosts.html", "delete", [{ type: "node.delete", nodeId: "inst-badge" }]);
    expect(read("screens/hosts.html")).toBe(host0.replace('      <zd-fx-badge data-oid="inst-badge" text="New"></zd-fx-badge>\n', ""));
    await call("design.history.undo");
    expect(read("screens/hosts.html")).toBe(host0);

    await apply("screens/hosts.html", "move", [{ type: "node.move", nodeId: "hosts-title", parentId: "hosts-root", beforeId: null }]);
    const title = '      <h1 data-oid="hosts-title">Instances</h1>\n';
    expect(read("screens/hosts.html")).toBe(host0.replace(title, "").replace("    </main>", `${title}    </main>`));
    await call("design.history.undo");
    expect(read("screens/hosts.html")).toBe(host0);
  });

  it("refuses to delete a placed main when asked only if unused, and reports instances of a main whose file is gone", async () => {
    const refused = await call("design.frame.delete", { frame: "library/chip.html", ifUnused: true });
    expect(refused.inUse).toEqual({ component: "fx-chip", title: "Chip \u2014 main", instances: 2, frames: 1 });
    expect(read("library/chip.html")).toContain("data-zd-options");

    await rm(path.join(root, "design/library/chip.html"));
    const missing = (await lint()).filter((violation) => violation.ruleId === "component-undefined");
    expect(missing.map((violation) => [violation.oid, violation.severity])).toEqual([["inst-set", "error"], ["inst-ignored", "error"]]);
    expect(missing[0]!.message).toContain("library/chip.html, which is missing");
    const host = await frame("screens/hosts.html");
    expect(host.srcDoc).toContain('<h1 data-oid="hosts-title">Instances</h1>');
    expect(host.srcDoc).not.toContain("chip-label");
  });

  it("puts and deletes canvas items, writing only those entries, and undo returns meta/canvas.json byte for byte", async () => {
    const canvas0 = read("meta/canvas.json");
    const put = await call("design.canvas.item.put", { pageId: "page_library", item: { kind: "note", x: 0, y: 300, width: 200, height: 80, text: "Added" } });
    const canvas1 = read("meta/canvas.json");
    // The new entry follows its neighbors, laid out on one line as they are.
    const { id, ...fields } = put.item;
    const entry = Object.entries({ ...fields, id }).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ");
    expect(canvas1).toBe(canvas0.replace('"target": "design/brief.md" }', `"target": "design/brief.md" },\n        { ${entry} }`));
    await call("design.canvas.item.delete", { pageId: "page_library", itemId: "item_section" });
    const canvas2 = read("meta/canvas.json");
    expect(canvas2).toBe(canvas1.replace(/\{ "id": "item_section"[^}]*\},\n {8}/, ""));
    await call("design.history.undo");
    expect(read("meta/canvas.json")).toBe(canvas1);
    await call("design.history.undo");
    expect(read("meta/canvas.json")).toBe(canvas0);
  });

  it("moves a frame by writing only its coordinate, and undo returns the coordinate", async () => {
    const canvas0 = read("meta/canvas.json");
    await call("design.canvas.update", { frame: "screens/hosts.html", x: 50, y: 0, w: 800, h: 600, z: 0 });
    const moved = read("meta/canvas.json");
    const at = '"source": "screens/hosts.html",\n      "title": "Hosts",\n      "x": ';
    // A frame transaction also registers the legacy components/ definition
    // in the foundation it persists; that block follows the existing members.
    const registered = canvas0.slice(0, -"\n}\n".length).replace(`${at}0`, `${at}50`);
    expect(moved.startsWith(registered)).toBe(true);
    expect(moved.slice(registered.length)).toMatch(/^,\n {2}"foundation": \{\n/);
    await call("design.history.undo");
    expect(read("meta/canvas.json")).toBe(moved.replace(`${at}50`, `${at}0`));
  });
});
