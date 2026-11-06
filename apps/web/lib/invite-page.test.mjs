import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  invitationTokenFromSearchParams,
  renderInvitationPage,
} from "./invite-page.mjs";

const TOKEN = "A".repeat(43);

test("the invitation query accepts exactly one capability parameter", () => {
  assert.deepEqual(
    invitationTokenFromSearchParams(
      new URLSearchParams(`invitation_token=${TOKEN}`),
    ),
    { token: TOKEN, tokenParameter: "invitation_token" },
  );
  for (const query of [
    `token=${TOKEN}&invitation_token=${TOKEN}`,
    `invitation_token=${TOKEN}&invitation_token=${TOKEN}`,
    `token=${TOKEN}&token=${TOKEN}`,
  ]) {
    assert.deepEqual(
      invitationTokenFromSearchParams(new URLSearchParams(query)),
      { token: "", tokenParameter: "token" },
    );
  }
});

function webScript(page) {
  const match = page.html.match(
    /<script nonce="testnonce">([\s\S]*?)<\/script>/,
  );
  assert.ok(match, "expected the invitation page to contain its bounded script");
  return match[1];
}

function testElement() {
  const classes = new Set(["hidden"]);
  return {
    listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    classList: {
      add: (value) => classes.add(value),
      remove: (value) => classes.delete(value),
      contains: (value) => classes.has(value),
    },
    textContent: "",
  };
}

async function runWebScript(page, storage, click = true) {
  const elements = new Map([
    ["message", testElement()],
    ["retry", testElement()],
    ["another", testElement()],
  ]);
  const replacements = [];
  const result = vm.runInNewContext(webScript(page), {
    document: {
      getElementById: (id) => elements.get(id),
    },
    fetch: async () => ({ status: 401 }),
    history: { replaceState() {} },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, value),
    },
    window: {
      location: {
        replace: (value) => replacements.push(value),
      },
    },
  });
  await result;
  if (click) await elements.get("retry").listeners.click();
  return { elements, replacements };
}

test("opening an invitation never changes membership or initiates acceptance", async () => {
  const page = renderInvitationPage({ token: TOKEN, scheme: "zeros-alpha", marketingOrigin: "https://zeros.build", mode: "web", nonce: "testnonce" });
  const { elements, replacements } = await runWebScript(page, new Map(), false);
  assert.deepEqual(replacements, []);
  assert.match(page.html, /id="retry" type="button">Accept invitation/);
  assert.equal(elements.get("retry").classList.contains("hidden"), false);
});

test("the invitation landing page offers exact-channel desktop and explicit web acceptance", () => {
  const page = renderInvitationPage({
    token: TOKEN,
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "landing",
    nonce: "testnonce",
  });

  assert.match(page.html, new RegExp(`zeros-alpha://invite\\?token=${TOKEN}`));
  assert.match(page.html, new RegExp(`/invite\\?token=${TOKEN}&amp;mode=web`));
  assert.doesNotMatch(page.html, /\/api\/v1\/invitations\/accept/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(
    page.headers.get("content-security-policy") ?? "",
    /script-src 'nonce-testnonce'/,
  );
});

test("a WorkOS custom invitation keeps its parameter through the bounded landing only", () => {
  const page = renderInvitationPage({
    token: TOKEN,
    tokenParameter: "invitation_token",
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "landing",
    nonce: "testnonce",
  });

  assert.match(
    page.html,
    new RegExp(`zeros-alpha://invite\\?invitation_token=${TOKEN}`),
  );
  assert.match(
    page.html,
    new RegExp(`/invite\\?invitation_token=${TOKEN}&amp;mode=web`),
  );
  assert.doesNotMatch(page.html, /[?&]token=/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
});

test("web mode accepts only through the authenticated same-origin JSON facade", () => {
  const page = renderInvitationPage({
    token: TOKEN,
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "web",
    nonce: "testnonce",
  });

  assert.match(page.html, /fetch\("\/api\/v1\/invitations\/accept"/);
  assert.match(page.html, /"X-Zeros-Request":"dashboard"/);
  assert.match(page.html, /credentials:"same-origin"/);
  assert.match(
    page.html,
    new RegExp(`/auth/start\\?return=${encodeURIComponent("/invite?mode=resume")}`),
  );
  assert.match(page.html, /sessionStorage\.setItem/);
  assert.doesNotMatch(
    page.html,
    new RegExp(`/auth/start[^"']*${TOKEN}`),
  );
  assert.match(page.html, /response\.status === 401/);
  assert.match(page.html, /wrong_account/);
  assert.match(page.html, /invite_preparing/);
  assert.doesNotMatch(page.html, /error\.message|response\.text/);
});

test("the post-AuthKit resume page recovers only the tab-scoped invitation", () => {
  const page = renderInvitationPage({
    token: "",
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "resume",
    nonce: "testnonce",
  });

  assert.match(page.html, /sessionStorage\.getItem/);
  assert.match(page.html, /This session expired\. Open the invitation email again\./);
  assert.doesNotMatch(page.html, /invite link is incomplete/i);
  assert.doesNotMatch(page.html, new RegExp(TOKEN));
});

test("a rejected post-AuthKit session stops after one authentication attempt", async () => {
  const storage = new Map();
  const initial = renderInvitationPage({
    token: TOKEN,
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "web",
    nonce: "testnonce",
  });
  const firstAttempt = await runWebScript(initial, storage);

  assert.equal(firstAttempt.replacements.length, 1);
  assert.equal(storage.get("zeros:invitation:auth-attempted"), "1");

  const resume = renderInvitationPage({
    token: "",
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "resume",
    nonce: "testnonce",
  });
  const rejectedResume = await runWebScript(resume, storage);

  assert.deepEqual(rejectedResume.replacements, []);
  assert.equal(
    rejectedResume.elements.get("message").textContent,
    "Sign-in didn’t create a session. Open the email again.",
  );
});

test("invalid tokens never enter script or deep-link output", () => {
  const page = renderInvitationPage({
    token: `bad"</script><script>alert(1)</script>`,
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "web",
    nonce: "testnonce",
  });

  assert.match(page.html, /invite link is incomplete/i);
  assert.doesNotMatch(page.html, /alert\(1\)|\/api\/v1\/invitations\/accept/);
});

test("the invitation pages follow the canvas copy on the shared shell", () => {
  const base = { token: TOKEN, scheme: "zeros-alpha", marketingOrigin: "https://zeros.build", nonce: "testnonce" };
  const landing = renderInvitationPage({ ...base, mode: "landing" }).html;
  assert.match(landing, /<style nonce="testnonce">/);
  assert.match(landing, /<div class="title">You’re invited to Zeros<\/div>/);
  assert.match(landing, /<div class="sub">Accept with the email this invite was sent to\.<\/div>/);
  assert.match(landing, /<div class="acts"><a class="btn" href="zeros-alpha:\/\/invite\?token=[^"]+">Open in Zeros<\/a><a class="btn ghost" href="[^"]+">Continue in browser<\/a><button class="btn ghost" id="copy" type="button">Copy link<\/button><\/div>/);
  assert.match(landing, /<p class="meta">Don’t have Zeros\? <a href="https:\/\/zeros\.build">Download it<\/a><\/p>/);
  assert.ok(landing.includes('"Copy this page’s address from the address bar."'));
  assert.ok(landing.includes('copy.setAttribute("aria-pressed", "true")'));

  const accept = renderInvitationPage({ ...base, mode: "web" }).html;
  assert.match(accept, /<div class="title">Accept your invitation<\/div>/);
  assert.match(accept, /<div class="sub" id="sub">Join using the account you’re signed in with\.<\/div>/);
  for (const copy of [
    "This invite is for another email. Switch accounts to accept.",
    "Zeros is unreachable. Your invitation wasn’t changed.",
    "Sign-in didn’t create a session. Open the email again.",
    "This invite expired or was used. Ask for a new one.",
    "Setup was still finishing. Nothing changed; try again.",
    "We couldn’t verify the invite. Nothing was changed.",
    "We couldn’t accept this invite. Nothing was changed.",
    "Allow tab storage, then open the email link again.",
  ]) {
    assert.ok(accept.includes(copy), copy);
  }
  assert.doesNotMatch(accept, /Choose Accept invitation/);

  const incomplete = renderInvitationPage({ ...base, token: "", mode: "landing" }).html;
  assert.match(incomplete, /<div class="title">This invite link is incomplete<\/div>/);
  assert.match(incomplete, /<p class="meta">Don’t have Zeros\? <a href="https:\/\/zeros\.build">Download it<\/a><\/p>/);
  assert.doesNotMatch(incomplete, /Get Zeros/);
});
