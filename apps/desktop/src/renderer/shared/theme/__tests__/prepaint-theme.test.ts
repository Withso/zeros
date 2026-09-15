import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync("index.html", "utf8");
const prepaintScript = html.match(
  /<!-- Pre-bundle theme stamp[\s\S]*?<script>([\s\S]*?)<\/script>/,
)?.[1] ?? "";

if (!prepaintScript) throw new Error("Missing pre-bundle theme stamp");

function stamp(options: {
  storedMode?: string;
  durableMode?: string;
  systemPrefersDark?: boolean;
}) {
  const attributes = new Map<string, string>();
  const stored =
    options.storedMode === undefined
      ? null
      : JSON.stringify({ mode: options.storedMode });
  const window = {
    __ZEROS_APPEARANCE_MODE__: options.durableMode,
    matchMedia: () => ({ matches: options.systemPrefersDark ?? true }),
  };
  vm.runInNewContext(prepaintScript, {
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) =>
          void attributes.set(name, value),
      },
    },
    localStorage: { getItem: () => stored },
    window,
  });
  return attributes;
}

describe("pre-bundle theme stamp", () => {
  it("stamps only data-theme — the retired palette attribute is gone", () => {
    const attributes = stamp({ storedMode: "dark" });
    expect(attributes.get("data-theme")).toBe("dark");
    expect(attributes.has("data-theme-palette")).toBe(false);
  });

  it("migrates a saved retired orka-black mode to dark", () => {
    const attributes = stamp({ storedMode: "orka-black" });
    expect(attributes.get("data-theme")).toBe("dark");
    expect(attributes.has("data-theme-palette")).toBe(false);
  });

  it("restores Light from the durable fallback after a cache purge", () => {
    const attributes = stamp({ durableMode: "light" });
    expect(attributes.get("data-theme")).toBe("light");
  });

  it("resolves System through the OS", () => {
    const attributes = stamp({
      storedMode: "system",
      systemPrefersDark: false,
    });
    expect(attributes.get("data-theme")).toBe("light");
    expect(attributes.has("data-theme-palette")).toBe(false);
  });
});
