import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Resolve through the shipping SDK, never Node's built-in fetch or another
// workspace's Undici: this is the dependency whose parser the override changes.
const rootRequire = createRequire(import.meta.url);
const cursorRequire = createRequire(rootRequire.resolve("@cursor/sdk"));
const connectRequire = createRequire(cursorRequire.resolve("@connectrpc/connect-node"));
const { Response } = connectRequire("undici") as { Response: typeof globalThis.Response };

describe("Cursor multipart dependency compatibility", () => {
  it.each([
    ["__proto__", false], ["__proto__", true],
    ["constructor", false], ["constructor", true],
    ["x-fixture", false], ["x-fixture", true],
  ] as const)("parses fields and files with %s headers (chunked: %s)", async (header, chunked) => {
    const boundary = "zeros-multipart-fixture";
    const body = [
      `--${boundary}`, 'Content-Disposition: form-data; name="marker"',
      `${header}: first`, "", "synthetic-marker",
      `--${boundary}`, 'Content-Disposition: form-data; name="upload"; filename="sample.txt"',
      "Content-Type: text/plain", `${header}: second`, "", "synthetic-file",
      `--${boundary}--`, "",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 11) controller.enqueue(bytes.slice(offset, offset + 11));
        controller.close();
      },
    });
    const response = new Response(chunked ? stream : body, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    const form = await response.formData();
    expect(form.get("marker")).toBe("synthetic-marker");
    const file = form.get("upload");
    if (!file || typeof file === "string") throw new Error("Multipart file was not preserved");
    expect(file.name).toBe("sample.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("synthetic-file");
    expect([...form.keys()]).toEqual(["marker", "upload"]);
  });
});
