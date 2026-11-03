import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let browser: Browser;
let source: string;
beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: path.resolve("apps/desktop/src/renderer/shell"), loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { useEditHistoryMenu } from "./use-edit-history-menu";
      import { Input } from "../shared/ui/primitives/input";
      import { Textarea } from "../shared/ui/primitives/textarea";
      function Fixture() {
        useEditHistoryMenu();
        const [a, setA] = React.useState("");
        const [b, setB] = React.useState("");
        return <><Textarea id="a" aria-label="Commit message" value={a} onChange={e => setA(e.target.value)} />
          <Input id="b" aria-label="Search" value={b} onChange={e => setB(e.target.value)} />
          <output>{JSON.stringify({a, b})}</output></>;
      }
      createRoot(document.getElementById("root")).render(<Fixture />);
    ` }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
    plugins: [{ name: "native-history-bridge", setup(builder) {
      builder.onResolve({ filter: /platform\/app$/ }, () => ({ path: "app", namespace: "native-history-bridge" }));
      builder.onLoad({ filter: /.*/, namespace: "native-history-bridge" }, () => ({ contents: "export const onMenuEditHistory = async () => () => {}; export const nativeEditHistory = async () => {};" }));
    } }], logLevel: "silent",
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });

describe("native controlled-input history", () => {
  it("never undoes another field when the focused field has an empty history", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: source });
      await page.locator("#a").click();
      await page.keyboard.type("commit message");
      await page.locator("#b").click();
      await page.keyboard.press("ControlOrMeta+z");
      expect(await page.locator("#a").inputValue()).toBe("commit message");
      expect(await page.locator("#b").evaluate(node => node === document.activeElement)).toBe(true);
      await page.locator("#a").click();
      await page.keyboard.press("ControlOrMeta+z");
      const undone = await page.locator("#a").inputValue();
      expect(undone).not.toBe("commit message");
      expect(await page.locator("output").textContent()).toBe(JSON.stringify({ a: undone, b: "" }));
      await page.keyboard.press("ControlOrMeta+Shift+z");
      expect(await page.locator("#a").inputValue()).toBe("commit message");
      expect(await page.locator("output").textContent()).toBe(JSON.stringify({ a: "commit message", b: "" }));
    } finally { await page.close(); }
  });
});
