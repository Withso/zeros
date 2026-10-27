import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { chromium } from "@playwright/test";
import ts from "typescript";
import { expect, it } from "vitest";

const source = readFileSync(new URL("../members-panel.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("members-panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const body = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "MembersBody")!.getText(ast);
const script = buildSync({
  stdin: { resolveDir: path.resolve("apps/desktop/src/renderer"), loader: "tsx", contents: `
    import React, { useState, useMemo, useCallback, useEffect } from "react";
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    import { KeyedAsyncCache } from "./shared/lib/keyed-async-cache";
    import { useRecoveringRead } from "./state/use-recovering-read";
    const f = window.members = { attempts: 0, toasts: [], team: "a" };
    const getOrganizationStoreGeneration = () => 1;
    class ControlPlaneError extends Error {}
    const controlPlane = {
      listMembers: async id => {
        f.attempts++;
        if (f.attempts === 1) throw new Error("temporary members failure");
        return { members: [{ id: "user", name: "Confirmed member" }] };
      }, listInvitations: async () => ({ invitations: [] }),
    };
    const toast = { error: error => f.toasts.push(error) };
    const errorMessage = error => error.message;
    const SettingsSection = ({ children }) => <section>{children}</section>;
    const SettingsList = ({ children }) => <div>{children}</div>;
    const Button = ({ children, onClick }) => <button onClick={onClick}>{children}</button>;
    const MemberRow = ({ member }) => <span>{member.name}</span>;
    const InviteComposer = () => null, PendingInviteRow = () => null;
    const SETTINGS_CARD_LIST_CLS = "";
    ${body}
    const root = createRoot(document.querySelector("#app"));
    f.render = () => flushSync(() => root.render(<MembersBody key={f.team} team={{id: f.team, role: "member"}} myUserId="user" refreshMe={async () => {}} />));
  ` },
  bundle: true, write: false, format: "iife", platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "silent",
}).outputFiles[0].text;

it("recovers the organization member list without a passive error toast", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: script });
    await page.evaluate(() => (window as any).members.render());
    await page.waitForFunction(() => (window as any).members.attempts === 1);
    expect(await page.evaluate(() => (window as any).members.toasts)).toEqual([]);
    await page.clock.runFor(1_500);
    await page.waitForFunction(() => document.body.textContent?.includes("Confirmed member"));
    expect(await page.evaluate(() => (window as any).members.attempts)).toBe(2);
  } finally { await browser.close(); }
});
