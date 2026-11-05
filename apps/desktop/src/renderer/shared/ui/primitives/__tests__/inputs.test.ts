import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildSync } from "esbuild";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { Checkbox } from "../checkbox";
import { Field } from "../field";
import { Input } from "../input";
import { Select, SelectTrigger, SelectValue } from "../select";
import { Slider } from "../slider";
import { Switch } from "../switch";
import { Textarea } from "../textarea";

function classes(markup: string, index = 0) {
  const all = [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]!);
  // Decode `&amp;` last, so a literal "&amp;#x27;" is not decoded twice.
  return new Set(all[index]!.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").split(/\s+/));
}

const KEYBOARD_RING = [
  "focus-visible:data-[zeros-keyboard-focus]:border-highlighted-bright",
  "focus-visible:data-[zeros-keyboard-focus]:ring-[3px]",
];

describe("the field box", () => {
  it("draws Input at 13/18 with 8px sides, a border4 hover and no stock shadow", () => {
    const set = classes(renderToStaticMarkup(createElement(Input, { "aria-label": "Name" })));
    for (const cls of ["h-7", "px-2", "text-xs", "leading-4.5", "border-border3", "hover:border-border4"]) {
      expect(set, cls).toContain(cls);
    }
    expect([...set].some((cls) => /^shadow(-|$)/.test(cls))).toBe(false);
    expect(set).not.toContain("px-3");
    expect(set).not.toContain("text-sm");
  });

  it("rings on keyboard focus only, never on every focus", () => {
    for (const element of [
      createElement(Input, { "aria-label": "Name" }),
      createElement(Textarea, { "aria-label": "Notes" }),
    ]) {
      const set = classes(renderToStaticMarkup(element));
      for (const cls of KEYBOARD_RING) expect(set, cls).toContain(cls);
      expect(set).not.toContain("focus-visible:border-highlighted-bright");
    }
  });

  it("shows invalid as a red border, and a red ring when focused by keyboard", () => {
    const set = classes(renderToStaticMarkup(createElement(Input, { "aria-invalid": true })));
    expect(set).toContain("aria-[invalid=true]:border-red-primary");
    expect(set).toContain("focus-visible:data-[zeros-keyboard-focus]:aria-[invalid=true]:ring-red-primary/30");
  });

  it("offers the compact 24px field, the inline rename look and a mono value", () => {
    expect(classes(renderToStaticMarkup(createElement(Input, { size: "compact" })))).toContain("h-6");
    const inline = classes(renderToStaticMarkup(createElement(Input, { appearance: "inline" })));
    expect(inline).toContain("border-transparent");
    expect(inline).toContain("hover:bg-bg2-highlight");
    expect(inline).toContain("rounded-sm");
    const mono = classes(renderToStaticMarkup(createElement(Input, { mono: true })));
    expect(mono).toContain("font-mono");
    expect(mono).toContain("text-3xxs");
  });

  it("gives Textarea three lines and the same box", () => {
    const set = classes(renderToStaticMarkup(createElement(Textarea, { "aria-label": "Notes" })));
    expect(set).toContain("min-h-17");
    expect(set).toContain("px-2");
    expect(set).not.toContain("min-h-[60px]");
  });
});

describe("Field", () => {
  it("labels the control and describes it with the hint", () => {
    const markup = renderToStaticMarkup(
      createElement(Field, { label: "Name", hint: "Shown to your team", children: createElement(Input) }),
    );
    const id = markup.match(/<input[^>]*id="([^"]+)"/)![1];
    expect(markup).toContain(`for="${id}"`);
    const describedBy = markup.match(/aria-describedby="([^"]+)"/)![1];
    expect(markup).toContain(`id="${describedBy}" class="text-fg3`);
    expect(markup).not.toContain("aria-invalid");
  });

  it("replaces the hint with the error and marks the control invalid", () => {
    const markup = renderToStaticMarkup(
      createElement(Field, {
        label: "Name",
        hint: "Shown to your team",
        error: "Name is required",
        optional: true,
        children: createElement(Input),
      }),
    );
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("Name is required");
    expect(markup).not.toContain("Shown to your team");
    expect(markup).toContain("text-red-primary");
    expect(markup).toContain(">Optional</span>");
  });
});

describe("Select trigger", () => {
  const trigger = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(
        Select,
        null,
        createElement(SelectTrigger, props, createElement(SelectValue, { placeholder: "Pick" })),
      ),
    );

  it("lines its value up with Input text and fades the placeholder to fg3", () => {
    const set = classes(trigger());
    expect(set).toContain("pl-2");
    expect(set).toContain("data-[placeholder]:text-fg3");
    for (const cls of KEYBOARD_RING) expect(set, cls).toContain(cls);
    expect(set).toContain("aria-[invalid=true]:border-red-primary");
  });

  it("draws the chevron muted-fg, fg2 on hover and open, not a faded fg2", () => {
    const markup = trigger();
    expect(markup).toContain("text-muted-fg");
    expect(markup).toContain("group-data-[state=open]/select-trigger:text-fg2");
    expect(markup).not.toMatch(/lucide-chevron-down[^"]*opacity-50/);
  });

  it("has a real 24px compact size", () => {
    expect(trigger({ size: "compact" })).toContain('data-size="compact"');
    expect(classes(trigger())).toContain("data-[size=compact]:py-0.5");
  });
});

describe("Checkbox", () => {
  it("is the 16px box with a 12px, 2px-stroke check", () => {
    const markup = renderToStaticMarkup(
      createElement(Checkbox, { checked: true, onChange: () => {}, "aria-label": "Copy" }),
    );
    expect(markup).toContain("size-4");
    expect(markup).toContain('stroke-width="2"');
    expect(markup).toMatch(/lucide-check[^"]*size-3/);
    expect(markup).toContain("hover:bg-primary-button-hover");
  });

  it("lifts an off box on hover and dims a disabled one to 50%", () => {
    const markup = renderToStaticMarkup(
      createElement(Checkbox, { checked: false, disabled: true, onChange: () => {}, "aria-label": "Copy" }),
    );
    expect(markup).toContain("hover:border-fg3");
    expect(markup).toContain("opacity-50");
    expect(markup).not.toContain("opacity-55");
  });

  it("makes the whole row the target when it has a label", () => {
    const markup = renderToStaticMarkup(
      createElement(Checkbox, { checked: false, onChange: () => {}, label: "Clip content", hint: "Hides overflow" }),
    );
    expect(markup).toMatch(/^<label class="group\/choice/);
    expect(markup).toContain("group-hover/choice:border-fg3");
    expect(markup).toContain(">Clip content</span>");
    expect(markup).toContain("text-fg3 text-3xxs leading-4");
  });
});

describe("Switch", () => {
  it("drops the track shadow, keeps one soft thumb shadow and lifts an off ring on hover", () => {
    const markup = renderToStaticMarkup(createElement(Switch, { "aria-label": "Sync" }));
    const track = classes(markup, 0);
    expect(track).not.toContain("shadow-sm");
    expect(track).toContain("data-[state=unchecked]:not-focus-visible:enabled:hover:border-fg3");
    expect(classes(markup, 1)).toContain("shadow-[var(--switch-thumb-shadow)]");
  });
});

describe("Slider", () => {
  it("draws a border3 track, an fg1 range and a 14px thumb, and dims whole when disabled", () => {
    const markup = renderToStaticMarkup(
      createElement(Slider, { defaultValue: [40], disabled: true, "aria-label": "Volume" }),
    );
    expect(classes(markup, 0)).toContain("data-[disabled]:opacity-50");
    expect(markup).toContain("bg-border3");
    expect(markup).toContain("bg-fg1 absolute");
    expect(markup).not.toContain("primary-button-bg");
  });
});

const script = buildSync({
  stdin: {
    resolveDir: path.resolve("apps/desktop/src/renderer"),
    loader: "tsx",
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import "./shared/ui/focus-navigation";
      import { Input } from "./shared/ui/primitives/input";
      const root = createRoot(document.querySelector("#app"));
      flushSync(() => root.render(
        <>
          <button id="before">Before</button>
          <Input id="name" aria-label="Name" />
        </>,
      ));
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  tsconfig: path.resolve("tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  logLevel: "silent",
}).outputFiles[0]!.text;

describe("field focus origin", () => {
  it("marks a field reached by Tab, and not one clicked into", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent('<div id="app"></div>');
      await page.addScriptTag({ content: script });
      const marked = () =>
        page.evaluate(() => document.querySelector("#name")!.hasAttribute("data-zeros-keyboard-focus"));

      await page.click("#name");
      await page.keyboard.type("Ada");
      expect(await marked()).toBe(false);

      await page.click("#before");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("name");
      expect(await marked()).toBe(true);

      // A click inside the focused field hands the cue back to the caret.
      await page.click("#name");
      expect(await marked()).toBe(false);
      await page.keyboard.press("Tab");
      expect(await marked()).toBe(false);
    } finally {
      await browser.close();
    }
  });
});
