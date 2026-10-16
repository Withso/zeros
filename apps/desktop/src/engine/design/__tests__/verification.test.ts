import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesignFrame, initializeDesignDocument } from "../document";
import { createDesignContextReference } from "../context";
import { designDirectoryNameFor, forgetDesignDirectoryName, withDesignDirectoryNameLease } from "../directory-registry";
import { startDesignVerificationService } from "../verification-service";
import { runDesignVerificationCli } from "../verification-cli";
import type { DesignEvidenceRenderer } from "../capture-client";
import { createDesignCaptureRenderer } from "../capture-client";
import { startDesignCaptureService, type DesignCaptureHost } from "../capture-service";

describe("native Design verification", () => {
  let root: string;
  let directory: string;
  let frame: string;
  let url: string;
  let now: number;
  let service: Awaited<ReturnType<typeof startDesignVerificationService>>;
  let render: ReturnType<typeof vi.fn<NonNullable<DesignEvidenceRenderer["renderComposed"]>>>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-frame-verify-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    await initializeDesignDocument(root);
    directory = designDirectoryNameFor(root);
    frame = (await createDesignFrame(root, { title: "Phone", geometry: { x: 0, y: 0, w: 390, h: 844, z: 0 } })).file;
    await writeFile(path.join(root, directory, frame), '<html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="screen">Phone</main></body></html>');
    await writeFile(path.join(root, directory, "tokens.css"), "body{margin:0;background:seagreen} @keyframes appear{from{opacity:0}to{opacity:1}}");
    render = vi.fn(async ({ state, viewport, html, sourceVersion }) => {
      expect(html).toContain("seagreen");
      expect(html).not.toContain("<script");
      // Transport/identity fixture. Real PNG pixels are qualified separately
      // with the native capture host, not claimed by this byte-header fixture.
      const bytes = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
      bytes.write("IHDR", 12); bytes.writeUInt32BE(viewport.width, 16); bytes.writeUInt32BE(viewport.height, 20);
      return { bytes, mimeType: "image/png", revision: state.revision, width: viewport.width, height: viewport.height, metadata: { sourceVersion } };
    });
    now = Date.now();
    service = await startDesignVerificationService({ now: () => now, renderer: () => ({ render, renderComposed: render }) });
    const reference = await createDesignContextReference(root, "workspace", frame);
    url = service.register({ workspaceId: "workspace", workspacePath: root, directory, directoryId: reference.directoryId }).url;
  });
  afterEach(async () => {
    await service?.stop(); forgetDesignDirectoryName(root); await rm(root, { recursive: true, force: true });
  });

  it("serves the same composed HTML/CSS revision and dimensions without writing source", async () => {
    const before = await readFile(path.join(root, directory, frame), "utf8");
    const state = await (await fetch(`${url}/${frame}/state`)).json();
    expect(state).toMatchObject({ width: 390, height: 844, reference: { frame, workspaceId: "workspace", frameId: expect.any(String) } });
    const preview = await fetch(`${url}/${frame}/`);
    expect(preview.headers.get("content-security-policy")).toContain("sha256-");
    expect(await preview.text()).toContain('sandbox="allow-same-origin"');
    const document = await fetch(`${url}/${frame}/document?revision=${state.reference.revision}`);
    expect(document.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = await document.text();
    expect(html).toContain("seagreen"); expect(html).toContain("@keyframes");
    expect(html).toContain(state.reference.revision);
    expect(await readFile(path.join(root, directory, frame), "utf8")).toBe(before);
  });

  it("binds each request independently when the server starts inside another directory read", async () => {
    const reference = await createDesignContextReference(root, "workspace", frame);
    const otherDirectory = "Other Design";
    await cp(path.join(root, directory), path.join(root, otherDirectory), { recursive: true });
    const manifest = path.join(root, otherDirectory, "meta/design.toml");
    await writeFile(manifest, (await readFile(manifest, "utf8")).replace(reference.directoryId, "design_other"));
    await writeFile(path.join(root, otherDirectory, frame), "<main>Other directory</main>");
    await service.stop();
    service = await withDesignDirectoryNameLease(root, directory, async () => {
      const started = await startDesignVerificationService({ renderer: () => undefined });
      expect(designDirectoryNameFor(root)).toBe(directory);
      return started;
    });
    const first = service.register({ workspaceId: "workspace", workspacePath: root, directory, directoryId: reference.directoryId });
    const second = service.register({ workspaceId: "workspace", workspacePath: root, directory: otherDirectory, directoryId: "design_other" });
    for (const [access, directoryId] of [[first, reference.directoryId], [second, "design_other"], [first, reference.directoryId]] as const) {
      const response = await fetch(`${access.url}/${frame}/state`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ reference: { directoryId } });
    }
    expect(await (await fetch(`${second.url}/${frame}/document`)).text()).toContain("Other directory");
    expect(await (await fetch(`${first.url}/${frame}/document`)).text()).toContain("Phone");
  });

  it("reports script and handler violations through the shell command while preserving authored source", async () => {
    const source = '<html><body><button data-oid="action" onclick="alert(1)">Send</button><script>alert(1)</script></body></html>';
    await writeFile(path.join(root, directory, frame), source);
    const lines: string[] = [];
    expect(await runDesignVerificationCli(["validate", "--url", url, "--frame", frame], (line) => lines.push(line))).toBe(1);
    const report = JSON.parse(lines[0]!).report;
    expect(report.violations.filter((item: { severity: string }) => item.severity === "error").length).toBeGreaterThanOrEqual(2);
    expect(await readFile(path.join(root, directory, frame), "utf8")).toBe(source);
    const document = await (await fetch(`${url}/${frame}/document`)).text();
    expect(document).not.toContain("onclick"); expect(document).not.toContain("<script");
  });

  it("writes an ordinary PNG with exact source and viewport metadata", async () => {
    const output = path.join(root, ".context", "phone.png");
    const lines: string[] = [];
    expect(await runDesignVerificationCli(["capture", "--url", url, "--frame", frame, "--output", output], (line) => lines.push(line))).toBe(0);
    const png = await readFile(output);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([390, 844]);
    expect(JSON.parse(lines[0]!)).toMatchObject({ path: output, width: 390, height: 844, motion: "reduced", reference: { revision: expect.any(String) } });
    expect(render).toHaveBeenCalledOnce();
  });

  it("captures and previews a named theme the way the canvas Themes control applies it", async () => {
    await writeFile(path.join(root, directory, "tokens.css"), 'body{margin:0;background:seagreen} [data-zd-theme="light"]{--gap:4px}');
    const output = path.join(root, ".context", "phone-light.png");
    const lines: string[] = [];
    expect(await runDesignVerificationCli(["capture", "--url", url, "--frame", frame, "--output", output, "--theme", "light"], (line) => lines.push(line))).toBe(0);
    expect(render.mock.calls[0]![0].html).toMatch(/<html[^>]* data-zd-theme="light"/);
    expect(JSON.parse(lines[0]!)).toMatchObject({ theme: "light" });
    const preview: string[] = [];
    expect(await runDesignVerificationCli(["preview", "--url", url, "--frame", frame, "--theme", "light"], (line) => preview.push(line))).toBe(0);
    expect(JSON.parse(preview[0]!).url).toContain("&theme=light");
    expect(await (await fetch(`${url}/${frame}/document?theme=light`)).text()).toMatch(/<html[^>]* data-zd-theme="light"/);
    expect((await fetch(`${url}/${frame}/document?theme=Not%20A%20Theme`)).status).toBe(400);
    await expect(runDesignVerificationCli(["capture", "--url", url, "--frame", frame, "--output", output, "--theme", "Bad Theme"]))
      .rejects.toThrow(/--theme/);
    await expect(runDesignVerificationCli(["validate", "--url", url, "--frame", frame, "--theme", "light"]))
      .rejects.toThrow(/capture and preview/);
    await expect(runDesignVerificationCli(["capture", "--url", url, "--frame", frame, "--output", output, "--theme"]))
      .rejects.toThrow(/--theme/);
    // A theme nothing declares would silently capture the default instead.
    await expect(runDesignVerificationCli(["preview", "--url", url, "--frame", frame, "--theme", "sepia"]))
      .rejects.toThrow('Unknown theme "sepia". Choose one of: light.');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("accepts a theme that only an imported style source maps", async () => {
    await mkdir(path.join(root, "styles"), { recursive: true });
    await writeFile(path.join(root, "styles/app.css"), ":root{--gap:2px} .sepia{--gap:3px}");
    const canvasFile = path.join(root, directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css", themes: { sepia: ".sepia" } }];
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
    const output = path.join(root, ".context", "phone-sepia.png");
    expect(await runDesignVerificationCli(["capture", "--url", url, "--frame", frame, "--output", output, "--theme", "sepia"], () => {})).toBe(0);
    const html = render.mock.calls[0]![0].html;
    expect(html).toMatch(/<html[^>]* data-zd-theme="sepia"/);
    expect(html).toContain('[data-zd-theme="sepia"]{--gap:3px}');
  });

  it("shows the named default theme when no theme is given, and accepts it by id", async () => {
    await mkdir(path.join(root, "styles"), { recursive: true });
    await writeFile(path.join(root, "styles/app.css"), ':root{--gap:2px} [data-theme="dark"]{--gap:4px}');
    const canvasFile = path.join(root, directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css", themes: { dark: '[data-theme="dark"]' } }];
    canvas.themes = [{ id: "dark", label: "Dark", base: true }];
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
    const output = path.join(root, ".context", "phone-default.png");
    expect(await runDesignVerificationCli(["capture", "--url", url, "--frame", frame, "--output", output], () => {})).toBe(0);
    expect(render.mock.calls.at(-1)![0].html).toMatch(/<html[^>]* data-zd-theme="dark"/);
    expect(await runDesignVerificationCli(["capture", "--url", url, "--frame", frame, "--output", output, "--theme", "dark"], () => {})).toBe(0);
    expect(render.mock.calls.at(-1)![0].html).toContain('[data-zd-theme="dark"]{--gap:4px}');
    const state = await (await fetch(`${url}/${frame}/state`)).json();
    const html = await (await fetch(`${url}/${frame}/document?revision=${state.reference.revision}`)).text();
    expect(html).toMatch(/<html[^>]* data-zd-theme="dark"/);
  });

  it("reports every style source's status through the read-only styles check", async () => {
    const lines: string[] = [];
    expect(await runDesignVerificationCli(["styles", "--url", url], (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines.pop()!)).toEqual({ directory, sources: [], errors: [], summary: { ready: 0, warning: 0, error: 0 } });

    await mkdir(path.join(root, "styles"), { recursive: true });
    await writeFile(path.join(root, "styles/app.css"), ':root{--bg1:black} [data-theme="light"]{--bg1:white}');
    const canvasFile = path.join(root, directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.styles = [
      { id: "app", title: "App", kind: "css", path: "styles/app.css", themes: { light: '[data-theme="light"]', dark: ".dark" } },
      { id: "gone", title: "Gone", kind: "css", path: "styles/gone.css" },
      { id: "Bad Id", kind: "css", path: "styles/app.css" },
    ];
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
    const before = await readFile(canvasFile, "utf8");
    expect(await runDesignVerificationCli(["styles", "--url", url], (line) => lines.push(line))).toBe(1);
    const report = JSON.parse(lines.pop()!);
    expect(report.summary).toEqual({ ready: 0, warning: 1, error: 1 });
    expect(report.errors).toEqual(["Style source 3 needs an id that starts with a letter (letters, digits, _ or -)."]);
    expect(report.sources).toEqual([
      {
        id: "app", title: "App", kind: "css", path: "styles/app.css", status: "warning", tokens: 1, themes: ["light", "dark"],
        bytes: expect.any(Number), messages: [{ level: "warning", text: 'Theme "dark": no rule uses the selector .dark.', action: "agent" }],
      },
      {
        id: "gone", title: "Gone", kind: "css", path: "styles/gone.css", status: "error", tokens: 0, themes: [], bytes: 0,
        messages: [{ level: "error", text: "styles/gone.css does not exist.", action: "agent" }],
      },
    ]);
    expect(await readFile(canvasFile, "utf8")).toBe(before);

    canvas.styles = [{ id: "app", title: "App", kind: "css", path: "styles/app.css", themes: { light: '[data-theme="light"]' } }];
    await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
    expect(await runDesignVerificationCli(["styles", "--url", url], (line) => lines.push(line))).toBe(0);
    expect(JSON.parse(lines.pop()!).summary).toEqual({ ready: 1, warning: 0, error: 0 });
    await expect(runDesignVerificationCli(["styles", "--url", url, "--theme", "light"]))
      .rejects.toThrow("--theme applies to capture and preview.");
    now += 31 * 60_000;
    await expect(runDesignVerificationCli(["styles", "--url", url])).rejects.toThrow("This Design preview expired");
  });

  it.each([
    { width: 390, height: 3000, rasterWidth: 266, rasterHeight: 2048 },
    { width: 390.5, height: 844.25, rasterWidth: 391, rasterHeight: 845 },
    { width: 16384, height: 16384, rasterWidth: 2048, rasterHeight: 2048 },
    { width: 1, height: 16384, rasterWidth: 1, rasterHeight: 2048 },
  ])("captures a $width × $height frame through the bounded host", async ({ width, height, rasterWidth, rasterHeight }) => {
    const capture = vi.fn<DesignCaptureHost>(async (input) => {
      const bytes = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
      bytes.write("IHDR", 12); bytes.writeUInt32BE(input.width, 16); bytes.writeUInt32BE(input.height, 20);
      return { bytes, renderer: "transport-fixture" };
    });
    const host = await startDesignCaptureService(capture);
    try {
      await service.stop();
      service = await startDesignVerificationService({ renderer: root => createDesignCaptureRenderer(root, host) });
      const sized = await createDesignFrame(root, { title: "Sized", geometry: { w: width, h: height } });
      const reference = await createDesignContextReference(root, "workspace", sized.file);
      const access = service.register({ workspaceId: "workspace", workspacePath: root, directory, directoryId: reference.directoryId });
      const output = path.join(root, ".context", "sized.png");
      const lines: string[] = [];
      expect(await runDesignVerificationCli(["capture", "--url", access.url, "--frame", sized.file, "--output", output], line => lines.push(line))).toBe(0);
      const png = await readFile(output);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([rasterWidth, rasterHeight]);
      expect(capture.mock.calls[0]![0]).toMatchObject({ width: rasterWidth, height: rasterHeight });
      if (width > 2048 || height > 2048) {
        expect(capture.mock.calls[0]![0]).toMatchObject({ layoutViewport: { width: Math.ceil(width), height: Math.ceil(height) } });
      }
      expect(JSON.parse(lines[0]!)).toMatchObject({ width: rasterWidth, height: rasterHeight, viewport: { width: Math.ceil(width), height: Math.ceil(height) }, reference });
    } finally {
      await host.stop();
    }
  });

  it("rejects old asset revisions and a same-name replacement frame", async () => {
    const state = await (await fetch(`${url}/${frame}/state`)).json();
    await writeFile(path.join(root, directory, "tokens.css"), "body{color:red}");
    expect((await fetch(`${url}/${frame}/capture?revision=${state.reference.revision}`)).status).toBe(409);
    expect((await fetch(`${url}/${frame}/state?frameId=frame_replacement`)).status).toBe(409);
    expect(render).not.toHaveBeenCalled();
  });

  it("does not publish pixels if source changes during capture", async () => {
    const original = render.getMockImplementation()!;
    render.mockImplementation(async (input) => {
      const result = await original(input);
      await writeFile(path.join(root, directory, frame), "<main data-oid=screen>Changed during capture</main>");
      return result;
    });
    const response = await fetch(`${url}/${frame}/capture`);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("changed during verification");
  });

  it("revokes expired and replaced directory access and rejects foreign origins", async () => {
    expect((await fetch(`${url}/${frame}/state`, { headers: { Origin: "https://unrelated.example" } })).status).toBe(403);
    const manifest = path.join(root, directory, "meta/design.toml");
    const original = await readFile(manifest, "utf8");
    const reference = await createDesignContextReference(root, "workspace", frame);
    await writeFile(manifest, original.replace(reference.directoryId, "design_replaced"));
    expect((await fetch(`${url}/${frame}/state`)).status).toBe(409);
    await writeFile(manifest, original);
    now += 31 * 60_000;
    expect((await fetch(`${url}/${frame}/state`)).status).toBe(410);
  });

  it("keeps an in-flight exact-owner read valid when a second context refreshes its lease", async () => {
    const reference = await createDesignContextReference(root, "workspace", frame);
    const original = render.getMockImplementation()!;
    render.mockImplementation(async (input) => {
      expect(service.register({ workspaceId: "workspace", workspacePath: root, directory, directoryId: reference.directoryId }).url).toBe(url);
      return original(input);
    });
    expect((await fetch(`${url}/${frame}/capture`)).status).toBe(200);
    service.revoke("workspace");
    expect((await fetch(`${url}/${frame}/state`)).status).toBe(410);
  });
});
