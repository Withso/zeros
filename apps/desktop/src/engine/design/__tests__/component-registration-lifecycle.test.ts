import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodeCanvasFile, encodeCanvasFile } from "../canvas-file";
import { designComponentRenderBytesForTests, rememberDesignComponentRender, resetDesignComponentRendersForTests } from "../component-last-good";
import {
  createDesignFrame,
  deleteDesignFrame,
  DESIGN_DIRECTORY_NAME,
  duplicateDesignFrame,
  renameDesignFrame,
  restoreDesignFrame,
} from "../document";
import { readCanvas, writeCanvas } from "../document-storage";
import { prepareFrameRenderSource } from "../render-preparation";

describe("a frame registered as a component", () => {
  let root: string;
  const canvasFile = () => path.join(root, DESIGN_DIRECTORY_NAME, "meta", "canvas.json");
  const register = async (file: string, name: string) => {
    const canvas = await readCanvas(root);
    canvas.frame_info[file] = { ...canvas.frame_info[file]!, component: name } as never;
    await writeCanvas(root, canvas);
  };
  const componentOf = async (file: string) => ((await readCanvas(root)).frame_info[file] as { component?: string } | undefined)?.component;

  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-components-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps its registration in the frame's record, through a title change", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await register(frame.file, "chat-composer");
    const records = Object.values(JSON.parse(await readFile(canvasFile(), "utf8")).frames) as { source: string; component?: string }[];
    expect(records.find((record) => record.source === frame.file)?.component).toBe("chat-composer");
    await renameDesignFrame(root, frame.file, "Composer");
    expect(await componentOf(frame.file)).toBe("chat-composer");
  });

  it("does not pass its registration to a duplicate", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await register(frame.file, "chat-composer");
    const copy = await duplicateDesignFrame(root, frame.file);
    expect(await componentOf(copy.file)).toBeUndefined();
    expect(await componentOf(frame.file)).toBe("chat-composer");
  });

  it("loses its registration and its last good render when deleted, and gets them back on undo", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await register(frame.file, "chat-composer");
    rememberDesignComponentRender(root, frame.file, "<html></html>");
    const restorePoint = await deleteDesignFrame(root, frame.file);
    expect(designComponentRenderBytesForTests().frames).toBe(0);
    expect(await componentOf(frame.file)).toBeUndefined();
    await restoreDesignFrame(root, restorePoint);
    expect(await componentOf(frame.file)).toBe("chat-composer");
  });

  it("renders as an instance in another frame through its registration", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file),
      '<!doctype html><html><head><template data-zd-options>\n<zd-option name="width" type="number" default="1120" unit="px"></zd-option>\n</template>' +
        '<style>.c { width: var(--zd-width); }</style></head><body><div class="c" data-oid="root">Composer</div></body></html>');
    await register(main.file, "chat-composer");
    const source = '<!doctype html><html><head></head><body><zd-chat-composer data-oid="ws" width="800"></zd-chat-composer></body></html>';
    const canvas = await readCanvas(root);
    const render = await prepareFrameRenderSource(root, source, { width: 400, height: 300 }, undefined, undefined, host.file, canvas);
    expect(render.sanitized).toContain('<div class="c" data-zd-part="root">Composer</div>');
    expect(render.sanitized).toContain("--zd-width: 800px;");
    expect(render.componentOptions).toBeUndefined();
  });
});

describe("canvas files and the component field", () => {
  const base = {
    version: 2,
    id: "main",
    title: "Design",
    pages: [{ id: "page_home", title: "Home", folder: "home", frames: ["home_main"] }],
    frames: { home_main: { kind: "html", source: "home/main.html", title: "Main", x: 0, y: 0, width: 100, height: 100 } },
  };

  const canonical = (value: unknown) => encodeCanvasFile(decodeCanvasFile(`${JSON.stringify(value, null, 2)}\n`, { version: 2 }), { version: 2 });

  it("read and write a canvas without the field exactly as before", () => {
    const text = canonical(base);
    expect(encodeCanvasFile(decodeCanvasFile(text, { version: 2 }), { version: 2 })).toBe(text);
    expect(text).not.toContain("component");
  });

  it("keep the field through a read and write by code that does not know it", () => {
    // Frame records pass unknown keys through, which is all an older build does with it.
    const text = canonical({ ...base, frames: { home_main: { ...base.frames.home_main, component: "chat-composer" } } });
    expect(text).toContain('"component": "chat-composer"');
    const decoded = decodeCanvasFile(text, { version: 2 });
    expect((decoded.frame_info as Record<string, { component?: string }>)["home/main.html"]!.component).toBe("chat-composer");
    expect(encodeCanvasFile(decoded, { version: 2 })).toBe(text);
    // The only difference from the same canvas without it is that one line.
    expect(text.replace(/\n\s*"component": "chat-composer",?/, "").replace(/,(\n\s*})/, "$1")).toBe(canonical(base));
  });
});
