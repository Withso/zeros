import fs from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { createElement, useState } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

function render(local: boolean) {
  const source = fs.readFileSync(
    "apps/desktop/src/renderer/features/settings/settings-page.tsx",
    "utf8",
  );
  const panel = source.slice(
    source.indexOf("function AccountPanel()"),
    source.indexOf("// ── Privacy"),
  );
  const module = {
    exports: {} as { AccountPanel: () => ReturnType<typeof createElement> },
  };
  vm.runInNewContext(
    transformSync(`export ${panel}`, {
      loader: "tsx",
      format: "cjs",
      jsx: "automatic",
    }).code,
    {
      module,
      require: () => jsxRuntime,
      useState,
      useAuth: () => ({
        email: null,
        session: null,
        status: "unauthenticated",
      }),
      isLocalDevelopment: () => local,
      accountAuthenticationProvider: () => null,
      accountAuthenticationProviderLabel: () => null,
      HINT_CLS: "text-fg3",
    },
  );
  return renderToStaticMarkup(createElement(module.exports.AccountPanel));
}

describe("Local Account settings", () => {
  it("explains account-free Local and where sign-in testing belongs", () => {
    const html = render(true);
    expect(html).toContain(
      "Zeros Local runs without a Zeros account. Use Zeros Dev to test sign-in.",
    );
    expect(html).not.toContain("not signed in");
  });
  it("preserves the signed-out copy for every other runtime", () => {
    const html = render(false);
    expect(html).toContain("not signed in");
    expect(html).not.toContain("Zeros Local");
  });
});
