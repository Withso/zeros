import { expect, it } from "vitest";
import { sanitizeForkSnapshot } from "../use-iframe-webview";

const snapshot = (manifest: unknown) => ({ html: "<main>Safe</main>", css: "", sourceSelector: "main", contentWidth: 800, contentHeight: 600,
  behaviorManifest: manifest, mockData: { images: [], texts: [] } });
const manifest = () => ({ formatVersion: 1, runtimeMode: "static", sourceUrl: "https://example.test/", behaviors: [], scriptRefs: [], platformHints: [] });

it("rebuilds only typed behavior fields without serializing untrusted extra graphs", () => {
  let visited = false;
  const input = { ...manifest(), unexpected: { toJSON() { visited = true; throw new Error("untrusted serialization"); } } };
  const result = sanitizeForkSnapshot(snapshot(input));
  expect(visited).toBe(false);
  expect(result?.behaviorManifest).toEqual(manifest());
});

it("rejects nested references where behavior scalar fields belong", () => {
  const shared: unknown[] = [];
  shared.push(shared);
  const input = { ...manifest(), behaviors: [{ kind: "gsap", selector: shared, confidence: "high" }] };
  expect(sanitizeForkSnapshot(snapshot(input))?.behaviorManifest).toBeUndefined();
});

it("does not scan beyond the retained mock-data array budget", () => {
  const images = Array.from({ length: 201 }, () => "image.png");
  Object.defineProperty(images, 200, { get() { throw new Error("visited beyond budget"); } });
  expect(sanitizeForkSnapshot({ ...snapshot(manifest()), mockData: { images, texts: [] } })?.mockData.images).toHaveLength(200);
});
