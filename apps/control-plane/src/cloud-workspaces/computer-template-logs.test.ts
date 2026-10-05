import { describe, expect, it } from "vitest";
import { ComputerTemplateLogRedactor } from "./computer-template-logs.js";

describe("computer build log boundary", () => {
  it("retains useful output and filters every split of a known credential", () => {
    const secret = "synthetic-clone-credential";
    for (let split = 1; split < secret.length; split++) {
      const filter = new ComputerTemplateLogRedactor([secret]);
      const output =
        filter.push("stdout", `installing ${secret.slice(0, split)}`) +
        filter.push("stdout", `${secret.slice(split)}\ncomplete\n`) +
        filter.finish("stdout");
      expect(output.includes(secret)).toBe(false);
      expect(output).toBe("installing [redacted]\ncomplete\n");
    }
  });

  it("filters token shapes, URLs, terminal escapes and split authorization lines", () => {
    const filter = new ComputerTemplateLogRedactor([]);
    const token = "ghs_" + "fixture".repeat(8);
    const output =
      filter.push("stderr", "\u001b[31mAuthorization: Bea") +
      filter.push(
        "stderr",
        `rer ${token}\nhttps://artifacts.example.test/private?signature=fixture\n`,
      ) +
      filter.finish("stderr");
    expect(output.includes(token)).toBe(false);
    expect(output).not.toContain("signature=");
    expect(output).not.toContain("\u001b");
    expect(output).toContain("[redacted]");
  });

  it("never releases a partial secret at end of stream or across a newline", () => {
    const filter = new ComputerTemplateLogRedactor([
      "private\nmultiline",
      "synthetic-credential",
    ]);
    const output =
      filter.push("stdout", "private\n") +
      filter.push("stdout", "multiline\nsynthetic-cre") +
      filter.finish("stdout");
    expect(output).toBe("[redacted]\n[redacted]");
  });

  it("bounds an unterminated line and keeps stdout/stderr buffers independent", () => {
    const filter = new ComputerTemplateLogRedactor(["synthetic-credential"]);
    const output =
      filter.push("stdout", "x".repeat(2_000_000)) +
      filter.push("stdout", "\nnext\n") +
      filter.finish("stdout");
    expect(Buffer.byteLength(output)).toBeLessThan(9000);
    expect(output).toContain("[build log line truncated]");
    expect(output).toContain("next\n");
    expect(filter.push("stderr", "separate\n")).toBe("separate\n");
  });
  it("does not reconstruct a known credential when stripping terminal escapes", () => {
    const filter = new ComputerTemplateLogRedactor(["synthetic-credential"]);
    const output = filter.push(
      "stdout",
      "synthetic-\u001b[31mcredential\u001b[0m\n",
    );
    expect(output.includes("synthetic-credential")).toBe(false);
  });
});
