// ──────────────────────────────────────────────────────────
// Appearance store — per-variant code-theme resolution
// ──────────────────────────────────────────────────────────
//
// Guards the 2026-07-12 fix for THE light-theme bug: the old store computed
// the variant default once at module load and then persisted it as an
// explicit pick, so light-theme users kept dark syntax colors forever
// (near-white code on the white editor/terminal/diff surfaces).
//
// The store is module-level stateful and reads localStorage / matchMedia /
// document at import time, so every test stubs the globals and dynamically
// imports a FRESH module instance (vi.resetModules).

import { describe, it, expect, beforeEach, vi } from "vitest";

const KEY = "zeros.appearance.v2";

function installDom(opts: { prefersDark?: boolean; stored?: unknown } = {}) {
  const systemListeners: Array<() => void> = [];
  const storage = new Map<string, string>();
  const attributes = new Map<string, string>();
  if (opts.stored !== undefined) storage.set(KEY, JSON.stringify(opts.stored));
  const mql = {
    matches: opts.prefersDark ?? true,
    addEventListener: (_: string, fn: () => void) => {
      systemListeners.push(fn);
    },
  };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal("window", {
    matchMedia: () => mql,
    addEventListener: () => {},
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 0;
    },
  });
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (name: string, value: string) =>
        void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
      classList: { add: () => {}, remove: () => {} },
    },
  });
  return {
    attributes,
    storage,
    /** Simulate a macOS appearance flip (prefers-color-scheme change). */
    flipSystem(dark: boolean) {
      mql.matches = dark;
      for (const fn of systemListeners) fn();
    },
  };
}

async function freshStore() {
  vi.resetModules();
  return import("../store");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("codeTheme resolution follows the variant", () => {
  it("no stored pick: dark app → Default, light app → Catppuccin Latte", async () => {
    installDom({ stored: { mode: "dark" } });
    let store = await freshStore();
    expect(store.getPrefs().codeTheme).toBe("default");

    installDom({ stored: { mode: "light" } });
    store = await freshStore();
    expect(store.getPrefs().codeTheme).toBe("catppuccin-latte");
    expect(store.getVariant()).toBe("light");
  });

  it("keeps Orka black dark for code themes but distinct for token repainting", async () => {
    const dom = installDom({ stored: { mode: "orka-black" } });
    const store = await freshStore();
    expect(store.getPrefs().mode).toBe("orka-black");
    expect(store.getPrefs().codeTheme).toBe("default");
    expect(store.getVariant()).toBe("dark");
    expect(store.getThemeId()).toBe("orka-black");
    expect(dom.attributes.get("data-theme")).toBe("dark");
    expect(dom.attributes.get("data-theme-palette")).toBe("orka-black");

    store.setPrefs({ mode: "dark" });
    expect(store.getThemeId()).toBe("dark");
    expect(dom.attributes.get("data-theme")).toBe("dark");
    expect(dom.attributes.has("data-theme-palette")).toBe(false);
  });

  it("re-resolves live on a mode change — the old bug froze it at load", async () => {
    installDom({ stored: { mode: "dark" } });
    const store = await freshStore();
    expect(store.getPrefs().codeTheme).toBe("default");
    store.setPrefs({ mode: "light" });
    expect(store.getPrefs().codeTheme).toBe("catppuccin-latte");
    store.setPrefs({ mode: "dark" });
    expect(store.getPrefs().codeTheme).toBe("default");
  });

  it("re-resolves (and notifies) on an OS flip in system mode", async () => {
    const dom = installDom({ prefersDark: true, stored: { mode: "system" } });
    const store = await freshStore();
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getPrefs().codeTheme));
    expect(store.getVariant()).toBe("dark");

    dom.flipSystem(false);
    expect(store.getVariant()).toBe("light");
    expect(store.getPrefs().codeTheme).toBe("catppuccin-latte");
    // Subscribers must fire — the pre-fix store emitted a reference-equal
    // prefs object here and every useSyncExternalStore consumer bailed.
    expect(seen).toEqual(["catppuccin-latte"]);
  });
});

describe("explicit picks", () => {
  it("are remembered per variant and don't leak across", async () => {
    installDom({ stored: { mode: "dark" } });
    const store = await freshStore();
    store.setPrefs({ codeTheme: "dracula" });
    expect(store.getPrefs().codeTheme).toBe("dracula");

    store.setPrefs({ mode: "light" });
    expect(store.getPrefs().codeTheme).toBe("catppuccin-latte"); // not dracula
    store.setPrefs({ codeTheme: "one-light" });
    expect(store.getPrefs().codeTheme).toBe("one-light");

    store.setPrefs({ mode: "dark" });
    expect(store.getPrefs().codeTheme).toBe("dracula"); // dark pick survived
  });

  it("persists ONLY explicit picks — never the derived default", async () => {
    const dom = installDom({ stored: { mode: "dark" } });
    const store = await freshStore();
    // A mode-only change must not freeze the resolved default into storage
    // (the exact mechanism of the original bug).
    store.setPrefs({ mode: "light" });
    const onDisk = JSON.parse(dom.storage.get(KEY)!);
    expect(onDisk.codeThemes).toEqual({});

    store.setPrefs({ codeTheme: "github-light" });
    const after = JSON.parse(dom.storage.get(KEY)!);
    expect(after.codeThemes).toEqual({ light: "github-light" });
  });
});

describe("durable-mode fallback (localStorage purged)", () => {
  it("adopts the preload-exposed userData mode when localStorage is empty", async () => {
    installDom(); // no stored prefs — simulates an OS purge of Caches
    (globalThis.window as unknown as Record<string, unknown>)[
      "__ZEROS_APPEARANCE_MODE__"
    ] = "light";
    const store = await freshStore();
    expect(store.getPrefs().mode).toBe("light");
    expect(store.getVariant()).toBe("light");
    expect(store.getPrefs().codeTheme).toBe("catppuccin-latte");
  });

  it("an actual localStorage value still wins over the fallback", async () => {
    installDom({ stored: { mode: "dark" } });
    (globalThis.window as unknown as Record<string, unknown>)[
      "__ZEROS_APPEARANCE_MODE__"
    ] = "light";
    const store = await freshStore();
    expect(store.getPrefs().mode).toBe("dark");
  });

  it("restores the durable Orka-black palette without changing its dark polarity", async () => {
    const dom = installDom();
    (globalThis.window as unknown as Record<string, unknown>)[
      "__ZEROS_APPEARANCE_MODE__"
    ] = "orka-black";
    const store = await freshStore();
    expect(store.getPrefs().mode).toBe("orka-black");
    expect(store.getVariant()).toBe("dark");
    expect(store.getThemeId()).toBe("orka-black");
    expect(dom.attributes.get("data-theme-palette")).toBe("orka-black");
  });
});

describe("legacy storage migration", () => {
  it("unfreezes the old implicit 'default' — light users finally get Latte", async () => {
    installDom({ stored: { mode: "light", codeTheme: "default" } });
    const store = await freshStore();
    expect(store.getPrefs().codeTheme).toBe("catppuccin-latte");
  });

  it("keeps a real legacy pick, slotted by its appearance", async () => {
    installDom({ stored: { mode: "dark", codeTheme: "nord" } });
    const store = await freshStore();
    expect(store.getPrefs().codeTheme).toBe("nord");
    store.setPrefs({ mode: "light" });
    expect(store.getPrefs().codeTheme).toBe("catppuccin-latte");
    store.setPrefs({ mode: "dark" });
    expect(store.getPrefs().codeTheme).toBe("nord");
  });

  it("migrates retired modes the same as before (high-contrast → system)", async () => {
    installDom({ prefersDark: true, stored: { mode: "high-contrast" } });
    const store = await freshStore();
    expect(store.getPrefs().mode).toBe("system");
    expect(store.getVariant()).toBe("dark");
  });

  it("does not repurpose the retired orka-night id for the new palette", async () => {
    installDom({ stored: { mode: "orka-night" } });
    const store = await freshStore();
    expect(store.getPrefs().mode).toBe("dark");
    expect(store.getThemeId()).toBe("dark");
  });
});
