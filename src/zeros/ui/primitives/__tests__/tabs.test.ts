import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Tabs, TabsList, TabsTrigger } from "../tabs";

describe("Tabs chrome variant", () => {
  it("renders panel tabs without a segmented-control container", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Tabs,
        { defaultValue: "layers" },
        createElement(
          TabsList,
          { variant: "chrome", "aria-label": "Design panels" },
          createElement(
            TabsTrigger,
            { variant: "chrome", value: "layers" },
            "Layers",
          ),
          createElement(
            TabsTrigger,
            { variant: "chrome", value: "assets" },
            "Assets",
          ),
        ),
      ),
    );

    expect(markup).toContain("bg-transparent");
    expect(markup).toContain("data-[state=active]:bg-bg2");
    expect(markup).not.toContain("rounded-lg bg-bg2 p-1");
    expect(markup).not.toContain('variant="chrome"');
  });
});
