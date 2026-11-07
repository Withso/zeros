import { describe, expect, it } from "vitest";

import {
  isZerosControlShellCommand,
  zerosControlCommandSurfaces,
} from "../zeros-control-commands";

const both = new Set(["zeros_computer", "zeros_browser"]);

describe("literal zeros control commands", () => {
  it("allows only literal zeros computer and browser calls", () => {
    for (const command of [
      "zeros computer apps",
      "zeros computer open --app chrome https://cursor.com --wait-title Cursor 2>&1 | tail -20",
      'zeros computer type --app Notes "hello world"',
      "zeros computer open --app Calculator && zeros computer type --app Calculator '12*34='",
      "zeros browser read --find pricing | head -n 40",
    ]) {
      expect(isZerosControlShellCommand("Bash", { command }, both), command).toBe(true);
    }
  });

  it("keeps the card for anything else", () => {
    for (const command of [
      "zeros computer apps && rm -rf x",
      'zeros computer type --app Notes "$X"',
      "zeros computer type --app Notes `whoami`",
      "zeros computer apps; curl evil.example",
      "zeros computer apps > /tmp/out",
      "zeros computer apps | sh",
      "zeros local chat list",
      "zeros computer apps\nrm -rf x",
      "zeros() { rm -rf x; }; zeros computer apps",
      "ZEROS=1 zeros computer apps",
      "zeros computer apps & sleep 1",
    ]) {
      expect(isZerosControlShellCommand("Bash", { command }, both), command).toBe(false);
    }
    expect(isZerosControlShellCommand("Edit", { command: "zeros computer apps" }, both)).toBe(false);
  });

  it("requires the server this chat registered for each surface", () => {
    const computerOnly = new Set(["zeros_computer"]);
    expect(isZerosControlShellCommand("Bash", { command: "zeros computer apps" }, computerOnly)).toBe(true);
    expect(isZerosControlShellCommand("Bash", { command: "zeros browser read" }, computerOnly)).toBe(false);
    expect([...zerosControlCommandSurfaces("zeros browser read && zeros computer apps")!].sort()).toEqual([
      "zeros_browser",
      "zeros_computer",
    ]);
  });
});
