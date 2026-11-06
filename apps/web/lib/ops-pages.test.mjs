import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OPS_CSP } from "./hosts.ts";
import { opsConsolePage, opsPolicy, opsStatePage } from "./ops-pages.mjs";

const developer = {
  user: { id: "u1", displayName: "Alex Morgan", email: "alex@example.com", role: "developer" },
  deploymentChannel: "alpha",
};
const owner = { ...developer, user: { ...developer.user, role: "platform_owner" } };
const console = (session, section = null) =>
  opsConsolePage({ session, section, signOutHref: "/auth/logout?return=https%3A%2F%2Fops.zeros.build%2F", nonce: "n0nce" });

test("each Ops page admits only its own inline block, by nonce", () => {
  assert.equal(opsPolicy(), OPS_CSP);
  const style = opsPolicy({ styleNonce: "abc" });
  assert.match(style, /style-src 'self' 'nonce-abc'/);
  assert.match(style, /script-src 'self';/);
  const script = opsPolicy({ scriptNonce: "xyz" });
  assert.match(script, /script-src 'self' 'nonce-xyz'/);
  assert.match(script, /style-src 'self';/);
  for (const policy of [style, script]) assert.doesNotMatch(policy, /unsafe-inline/);
});

test("the centred Ops states follow the canvas, with Ops beside the logo", () => {
  const copy = {
    signIn: ["Restricted operations", "Staff only. Sign in with an owner or developer account.", "Continue with WorkOS", "btn"],
    reauthenticate: ["Sign in again", "Ops needs a sign-in from the last 5 minutes.", "Reauthenticate", "btn"],
    denied: ["Access denied", "This account has no owner or developer role.", "Sign out", "btn secondary"],
    unavailable: ["Ops is unavailable", "Couldn’t reach the control plane. Try again shortly.", "Try again", "btn"],
  };
  for (const [kind, [title, line, action, classes]] of Object.entries(copy)) {
    const page = opsStatePage(kind, { href: '/auth/start?return="x"', nonce: "abc" });
    assert.ok(page.includes(`<title>${title} · Zeros Ops</title>`), kind);
    assert.match(page, /<style nonce="abc">/);
    // The policy admits that one stylesheet and no script.
    assert.equal(page.match(/<style\b/g).length, 1);
    assert.doesNotMatch(page, /<script|\sstyle=/);
    assert.match(page, /aria-label="Zeros home">[^]*?<\/a><span class="badge">Ops<\/span><\/header>/);
    assert.ok(page.includes(`<div class="title">${title}</div>`), kind);
    assert.ok(page.includes(`<div class="sub">${line}</div>`), kind);
    assert.ok(page.includes(`<div class="acts"><a class="${classes}" href="/auth/start?return=&quot;x&quot;">${action}</a></div>`), kind);
  }
});

test("the developer console is the dashboard layout with Deletion recovery only", () => {
  const page = console(developer, "identity");
  assert.match(page, /<script nonce="n0nce">\(\(\)=>\{const m=matchMedia/);
  assert.match(page, /<link rel="stylesheet" href="\/dashboard\.css\?v=[\w.-]+" \/>\s*<link rel="stylesheet" href="\/ops\.css\?v=[\w.-]+" \/>/);
  assert.match(page, /<script type="module" src="\/ops\.js\?v=[\w.-]+"><\/script>/);
  assert.match(page, /<div class="sidebar-band"><a class="brand" href="\/" aria-label="Zeros home"><svg class="brand-mark"[^]*?<\/a><span class="badge ops-badge">Ops<\/span><\/div>/);
  assert.match(page, /<p class="nav-label first">Recovery<\/p>\s*<div class="nav-list"><a class="nav-row" href="\/" aria-current="page"><svg[^]*?<\/svg><span class="nav-name">Deletion recovery<\/span><\/a><\/div>/);
  assert.doesNotMatch(page, /Identity recovery|identity-recovery-form/);
  assert.match(page, /<span class="row-name">alex@example\.com<\/span><span class="row-hint">Developer · alpha<\/span>/);
  assert.match(page, /<a class="nav-row" href="\/auth\/logout\?return=https%3A%2F%2Fops\.zeros\.build%2F"><svg[^]*?<\/svg><span class="nav-name">Sign out<\/span><\/a>/);
  assert.match(page, /<main class="main-content layout" data-role="developer">/);
  assert.match(page, /<h1>Deletion recovery<\/h1><p>Look up one request by recovery code and support case\.<\/p>/);
  assert.match(page, /<span class="row-name">Deletion recovery code<\/span><span class="row-hint">ZD-XXXX-XXXX<\/span><\/span><span class="row-ctl"><input class="input mono" name="code" required pattern="ZD-\[A-Z2-9\]\{4\}-\[A-Z2-9\]\{4\}"/);
  assert.match(page, /<span class="row-name">Ownership verified<\/span><span class="row-hint">Out-of-band verification is recorded in the support case\.<\/span><\/span><span class="row-ctl"><input class="check" name="ownershipVerified" type="checkbox" required/);
  assert.match(page, /<button class="button primary" type="submit">Look up request<\/button>/);
  assert.match(page, /<button id="purge-button" class="button danger-secondary" type="button">Force purge<\/button><button id="restore-button" class="button primary" type="button">Restore<\/button>/);
  assert.match(page, /Type <span class="phrase" id="purge-phrase"><\/span> to continue\./);
  assert.match(page, /<button id="purge-confirm-button" class="button danger" type="button">Permanently purge now<\/button>/);
  assert.match(page, /<label class="seg-item"><input type="radio" name="capability" value="deletion\.restore" checked \/>Restore<\/label>/);
});

test("platform owners also get Identity recovery as its own section", () => {
  const deletion = console(owner);
  assert.match(deletion, /aria-current="page"><svg[^]*?<\/svg><span class="nav-name">Deletion recovery<\/span><\/a><a class="nav-row" href="\/\?section=identity" aria-current="false">/);
  assert.match(deletion, /<span class="row-hint">Platform owner · alpha<\/span>/);
  const identity = console(owner, "identity");
  assert.match(identity, /<title>Identity recovery · Zeros Ops<\/title>/);
  assert.match(identity, /href="\/\?section=identity" aria-current="page">/);
  assert.match(identity, /<form id="identity-recovery-form" class="contents">/);
  assert.match(identity, /pattern="ZR-\[A-Z2-9\]\{4\}-\[A-Z2-9\]\{4\}" placeholder="ZR-XXXX-XXXX"/);
  assert.match(identity, /<button class="button primary" type="submit">Approve identity link<\/button>/);
  assert.doesNotMatch(identity, /id="lookup-form"/);
});

test("the console carries every hook ops.js uses and no inline style the policy would block", async () => {
  const script = await readFile(new URL("../public/ops.js", import.meta.url), "utf8");
  const ids = [...script.matchAll(/getElementById\("([^"]+)"\)/g)].map(([, id]) => id);
  const identityOnly = new Set(["identity-recovery-form", "identity-result"]);
  const deletion = console(owner);
  const identity = console(owner, "identity");
  for (const id of ids) {
    assert.ok((identityOnly.has(id) ? identity : deletion).includes(`id="${id}"`), id);
  }
  for (const page of [deletion, identity, console(developer)]) {
    assert.doesNotMatch(page, /\sstyle=|<style/);
    assert.equal(page.match(/<script(?![^>]*\bsrc=)[^>]*>/g)?.length, 1);
    assert.match(page, /<script nonce="n0nce">/);
  }
});

test("console identity is escaped", () => {
  const page = console({ ...developer, user: { ...developer.user, email: "a<b>@example.com", displayName: "<x>" } });
  assert.match(page, /a&lt;b&gt;@example\.com/);
  assert.doesNotMatch(page, /a<b>@/);
});
