import { expect, it } from "vitest";
import { githubGitDownload } from "./github-git-stream.js";
it("never emits connected user credentials across response chunks", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const part of ["PACK bytes syn", "thetic-user-token more"]) controller.enqueue(Buffer.from(part));
    controller.close();
  } });
  await expect(new Response(githubGitDownload(stream, ["synthetic-user-token"])).text()).rejects.toThrow("GitHub response unavailable");
});
it("streams large packs and hides upstream failure details", async () => {
  const body = Buffer.alloc(5 * 1024 * 1024, 42);
  expect((await new Response(githubGitDownload(new Response(body).body, ["synthetic-user-token"])).arrayBuffer()).byteLength).toBe(body.length);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("synthetic-user-token")); } });
  await expect(new Response(githubGitDownload(stream, ["synthetic-user-token"])).text()).rejects.toThrow("GitHub response unavailable");
});
