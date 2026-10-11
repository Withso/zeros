import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("../../../shared/ui/primitives/elements", () => ({
  toast: { error: toastError },
}));
// Source recovery talks to the native runtime/IndexedDB; the pill metadata
// produced by the shared paste/drop ingestion is what matters here.
vi.mock("../../agent/attachment-sources", () => ({
  prepareAttachmentSource: vi.fn(async () => undefined),
}));

import {
  clearPendingFileDeliveriesForTesting,
  registerLiveChatFileStager,
  type ComposerFileDelivery,
} from "../../agent/composer-file-attachment-delivery";
import { filesToAttachments } from "../../agent/composer-editor/attachment-io";
import {
  buildElementDetailsText,
  elementScreenshotFile,
  stageSelectedElementsInComposer,
} from "../element-composer-staging";
import type { SelectedElement } from "../use-iframe-webview";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DATA_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`;

function element(overrides: Partial<SelectedElement> = {}): SelectedElement {
  return {
    selector: "div#root > ul > li:nth-of-type(1)",
    tag: "li",
    componentName: "TaskApp",
    rect: { x: 0, y: 0, width: 768, height: 66 },
    click: { x: 10, y: 10 },
    styles: {
      fontWeight: "400",
      fontSize: "14px",
      display: "list-item",
      margin: "auto",
      lineHeight: "normal",
      border: "none",
    },
    altKey: false,
    hasShadowRoot: false,
    href: "http://localhost:5173/",
    screenshot: PNG_DATA_URL,
    ...overrides,
  };
}

async function readText(file: File): Promise<string> {
  return new TextDecoder().decode(await file.arrayBuffer());
}

describe("buildElementDetailsText", () => {
  it("leads with the prompt, then the element details", () => {
    expect(
      buildElementDetailsText([element()], "  Do you like the design  ", ""),
    ).toBe(
      "Do you like the design\n\n" +
        "Selected element: TaskApp (<li>)\n" +
        "  selector: div#root > ul > li:nth-of-type(1)\n" +
        "  url: http://localhost:5173/\n" +
        "  computed styles:\n" +
        "  fontWeight: 400\n" +
        "  fontSize: 14px\n" +
        "  display: list-item",
    );
  });

  it("omits an empty prompt and falls back to the tab URL and bare tag", () => {
    expect(
      buildElementDetailsText(
        [
          element({
            componentName: null,
            href: "",
            styles: undefined,
            hasShadowRoot: true,
          }),
        ],
        "   ",
        "http://localhost:3000/tab",
      ),
    ).toBe(
      "Selected element: <li>\n" +
        "  selector: div#root > ul > li:nth-of-type(1)\n" +
        "  url: http://localhost:3000/tab\n" +
        "  note: inside shadow-DOM",
    );
  });

  it("numbers every element in one document", () => {
    const text = buildElementDetailsText(
      [
        element({ styles: undefined }),
        element({
          tag: "button",
          componentName: null,
          selector: "button.save",
          styles: undefined,
        }),
      ],
      "Align these",
      "",
    );
    expect(text).toBe(
      "Align these\n\n" +
        "Selected 2 elements:\n\n" +
        "1. TaskApp (<li>)\n" +
        "  selector: div#root > ul > li:nth-of-type(1)\n" +
        "  url: http://localhost:5173/\n\n" +
        "2. <button>\n" +
        "  selector: button.save\n" +
        "  url: http://localhost:5173/",
    );
  });
});

describe("elementScreenshotFile", () => {
  it("names a PNG capture .png with image/png and the decoded bytes", async () => {
    const file = elementScreenshotFile(element(), 0);
    expect(file?.name).toBe("li-1.png");
    expect(file?.type).toBe("image/png");
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("follows the real MIME type and skips missing or malformed captures", () => {
    const jpeg = elementScreenshotFile(
      element({ screenshot: `data:image/jpeg;base64,${btoa("jpeg")}` }),
      2,
    );
    expect(jpeg?.name).toBe("li-3.jpg");
    expect(jpeg?.type).toBe("image/jpeg");
    expect(elementScreenshotFile(element({ screenshot: undefined }), 0)).toBeNull();
    expect(
      elementScreenshotFile(element({ screenshot: "data:text/html;base64,PGI+" }), 0),
    ).toBeNull();
    expect(
      elementScreenshotFile(element({ screenshot: "data:image/png;base64,%%%" }), 0),
    ).toBeNull();
  });
});

describe("stageSelectedElementsInComposer", () => {
  let delivered: Map<string, ComposerFileDelivery[]>;
  const mount = (chatId: string) =>
    registerLiveChatFileStager(chatId, (d) => {
      delivered.set(chatId, [...(delivered.get(chatId) ?? []), d]);
      return true;
    });

  beforeEach(() => {
    delivered = new Map();
    toastError.mockReset();
  });
  afterEach(() => clearPendingFileDeliveriesForTesting());

  it("toasts and stages nothing without an active chat", () => {
    const unmount = mount("chat-a");
    const result = stageSelectedElementsInComposer({
      elements: [element()],
      prompt: "keep me",
      tabUrl: "",
      activeChatId: null,
    });
    expect(result).toEqual({ ok: false, reason: "no-active-chat" });
    expect(toastError).toHaveBeenCalledWith(
      "No active chat to attach this element to.",
      { description: "Open or create a chat first." },
    );
    expect(delivered.size).toBe(0);
    unmount();
  });

  it("does nothing for an empty selection", () => {
    expect(
      stageSelectedElementsInComposer({
        elements: [],
        prompt: "",
        tabUrl: "",
        activeChatId: "chat-a",
      }),
    ).toEqual({ ok: false, reason: "no-elements" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("stages one image per screenshot plus one details text file", async () => {
    const unmount = mount("chat-a");
    const result = stageSelectedElementsInComposer({
      elements: [
        element(),
        element({ tag: "button", screenshot: undefined }),
        element({ tag: "span", componentName: "Badge" }),
      ],
      prompt: "Tighten these",
      tabUrl: "",
      activeChatId: "chat-a",
    });
    expect(result.ok && result.outcome).toBe("staged");
    const [d] = delivered.get("chat-a") ?? [];
    expect(d.files.map((f) => [f.name, f.type])).toEqual([
      ["li-1.png", "image/png"],
      ["span-3.png", "image/png"],
      ["selected-elements.txt", "text/plain"],
    ]);
    const text = await readText(d.files[2]);
    expect(text.startsWith("Tighten these\n\nSelected 3 elements:")).toBe(true);
    expect(text).toContain("2. TaskApp (<button>)");
    expect(text).toContain("3. Badge (<span>)");
    unmount();
  });

  it("queues for an unmounted chat and lands only in that chat", () => {
    const result = stageSelectedElementsInComposer({
      elements: [element()],
      prompt: "",
      tabUrl: "",
      activeChatId: "chat-a",
    });
    expect(result.ok && result.outcome).toBe("queued");

    const unmountOther = mount("chat-b");
    expect(delivered.get("chat-b")).toBeUndefined();
    const unmountTarget = mount("chat-a");
    expect(delivered.get("chat-a")?.[0].files.map((f) => f.name)).toEqual([
      "li-1.png",
      "TaskApp-details.txt",
    ]);
    unmountOther();
    unmountTarget();
  });

  it("uses the identical paste/drop pipeline for Local and cloud chats", async () => {
    // Placement is resolved by the destination composer's own cwd
    // (local path or cloud:// key); the staged payload has no placement input.
    const unmountLocal = mount("local-chat");
    const unmountCloud = mount("cloud-chat");
    const args = { elements: [element()], prompt: "Review", tabUrl: "" };
    stageSelectedElementsInComposer({ ...args, activeChatId: "local-chat" });
    stageSelectedElementsInComposer({ ...args, activeChatId: "cloud-chat" });

    const summarize = async (chatId: string) => {
      const files = delivered.get(chatId)![0].files;
      const atts = await filesToAttachments(files, {
        agentName: null,
        agentSupportsImage: true,
        modelId: null,
      });
      return Promise.all(
        atts.map(async (a) => ({
          name: a.name,
          mimeType: a.mimeType,
          kind: a.kind,
          delivery: a.delivery,
          valid: a.validation.ok,
          bytes: Array.from(new Uint8Array(await a.sourceFile!.arrayBuffer())),
        })),
      );
    };
    const local = await summarize("local-chat");
    expect(local.map(({ bytes: _bytes, ...rest }) => rest)).toEqual([
      {
        name: "li-1.png",
        mimeType: "image/png",
        kind: "image",
        delivery: "reference",
        valid: true,
      },
      {
        name: "TaskApp-details.txt",
        mimeType: "text/plain",
        kind: "file",
        delivery: "reference",
        valid: true,
      },
    ]);
    expect(await summarize("cloud-chat")).toEqual(local);
    unmountLocal();
    unmountCloud();
  });
});
