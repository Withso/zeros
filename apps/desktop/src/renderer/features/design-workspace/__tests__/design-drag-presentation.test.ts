// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesignDragPresentation, createDesignFrameNudgeChrome } from "../design-drag-presentation";

const mocks = vi.hoisted(() => ({ runtimeState: null as any, zoom: 1 }));
vi.mock("../state/design-runtime-store", () => ({ designRuntimeFrameState: () => mocks.runtimeState }));
vi.mock("../state/design-workspace-ui", () => ({ designWorkspaceView: () => ({ zoom: mocks.zoom }) }));

const version = "a".repeat(24);
const frame = { file: "page/home.html", frameId: "home", pageId: "page", title: "Home", x: 10, y: 20, width: 100, height: 80,
  z: 0, nodeCount: 1, modifiedAt: 1, sourceVersion: version } as any;
const root = { oid: "root", rect: { x: 0, y: 0, width: 100, height: 80 } };
const picture = (scale: number, nodeId: string | null = null) =>
  ({ sourceVersion: version, dataUrl: `data:image/png;base64,${scale}`, mimeType: "image/png", width: 100 * scale, height: 80 * scale, scale, nodeId });

let world: HTMLElement, article: HTMLElement;
function vectorSource() {
  const image = document.createElement("img");
  image.setAttribute("data-design-source-ready", "");
  image.dataset.designSourceVersion = version;
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "naturalWidth", { value: 100 });
  image.src = "blob:vector-source";
  article.appendChild(image);
}
const shown = () => world.querySelector<HTMLImageElement>("[data-design-drag-pixels] img")?.getAttribute("src");

beforeEach(() => {
  world = document.createElement("div");
  world.setAttribute("data-design-canvas-world", "");
  article = document.createElement("article");
  article.setAttribute("data-design-frame", frame.file);
  world.appendChild(article);
  document.body.appendChild(world);
  mocks.zoom = 1;
  mocks.runtimeState = null;
  vi.stubGlobal("devicePixelRatio", 2);
  vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/["\\]/g, "\\$&") });
});
afterEach(() => {
  world.remove();
  vi.unstubAllGlobals();
});

describe("drag and copy pixels", () => {
  it("shows the frame's ready vector source instead of a cached picture made for a smaller zoom", () => {
    mocks.runtimeState = { screenshotsByNode: { "": picture(0.25) } };
    vectorSource();
    const presentation = createDesignDragPresentation("local", frame, root, article)!;
    expect(shown()).toBe("blob:vector-source");
    expect(presentation.sharp).toBe(true);
  });

  it("keeps a cached picture that already has the drawn resolution", () => {
    mocks.runtimeState = { screenshotsByNode: { "": picture(2) } };
    vectorSource();
    const presentation = createDesignDragPresentation("local", frame, root, article)!;
    expect(shown()).toBe(picture(2).dataUrl);
    expect(presentation.sharp).toBe(true);
  });

  it("asks for the drawn resolution, bounded, and reports a blurry picture as not sharp", () => {
    mocks.zoom = 1.5;
    mocks.runtimeState = { screenshotsByNode: { "": picture(0.75) } };
    const presentation = createDesignDragPresentation("local", frame, root, article)!;
    expect(presentation.wantedScale).toBe(3);
    expect(presentation.sharp).toBe(false);
    mocks.zoom = 8;
    expect(createDesignDragPresentation("local", frame, root, article)!.wantedScale).toBe(4);
  });

  it("replaces a blurry picture with a sharper capture, but never with a blurrier one", () => {
    mocks.runtimeState = { screenshotsByNode: { "": picture(0.25) } };
    const presentation = createDesignDragPresentation("local", frame, root, article)!;
    presentation.adopt({ ...picture(2), nodeId: "root" });
    expect(shown()).toBe(picture(2).dataUrl);
    expect(presentation.sharp).toBe(true);
    presentation.adopt({ ...picture(1), nodeId: "root" });
    expect(shown()).toBe(picture(2).dataUrl);
  });

  it("does not let a crop replace the vector source", () => {
    mocks.runtimeState = { screenshotsByNode: {} };
    vectorSource();
    const presentation = createDesignDragPresentation("local", frame, root, article)!;
    presentation.adopt({ ...picture(4), nodeId: "root" });
    expect(shown()).toBe("blob:vector-source");
  });

  it("draws a moving frame copy's name above its pixels in the selection color, and a component's in its own", () => {
    createDesignDragPresentation("local", frame, root, article, { name: { text: "Checkout" } });
    const name = world.querySelector<HTMLElement>("[data-design-drag-name]")!;
    expect(name.textContent).toBe("Checkout");
    expect(name.className).toContain("text-[var(--design-selection-stroke)]");
    expect(name.className).toContain("bottom-full");
    expect(name.style.maxWidth).toBe("calc(100px * var(--design-canvas-zoom))");
    name.parentElement!.remove();
    createDesignDragPresentation("local", frame, root, article, { name: { text: "Card", component: true } });
    expect(world.querySelector("[data-design-drag-name]")!.className).toContain("text-violet-text");
  });

  it("draws no name on a layer's drag picture", () => {
    createDesignDragPresentation("local", frame, root, article, { selection: true });
    expect(world.querySelector("[data-design-drag-name]")).toBeNull();
  });
});

describe("frame chrome through keyboard nudges", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("hides selection chrome on each nudge and brings it back once the frames rest", () => {
    vi.useFakeTimers();
    const chrome = createDesignFrameNudgeChrome(1_000);
    const other = document.createElement("article");
    chrome.hold([article, null]);
    expect(article.getAttribute("data-design-frame-gesture")).toBe("move");
    vi.advanceTimersByTime(900);
    // A held key repeats: each step restarts the rest.
    chrome.hold([article, other]);
    vi.advanceTimersByTime(900);
    expect(article.getAttribute("data-design-frame-gesture")).toBe("move");
    expect(other.getAttribute("data-design-frame-gesture")).toBe("move");
    vi.advanceTimersByTime(100);
    expect(article.hasAttribute("data-design-frame-gesture")).toBe(false);
    expect(other.hasAttribute("data-design-frame-gesture")).toBe(false);
  });

  it("brings the chrome back at once when the nudge is cancelled", () => {
    vi.useFakeTimers();
    const chrome = createDesignFrameNudgeChrome(1_000);
    chrome.hold([article]);
    chrome.release();
    expect(article.hasAttribute("data-design-frame-gesture")).toBe(false);
    // The cancelled rest does not fire later over a new gesture's chrome.
    article.setAttribute("data-design-frame-gesture", "resize");
    vi.advanceTimersByTime(2_000);
    expect(article.getAttribute("data-design-frame-gesture")).toBe("resize");
  });
});
