import assert from "node:assert/strict";
import test from "node:test";

import { renderInvitationPage } from "./invite-page.mjs";

const TOKEN = "A".repeat(43);

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
  assert.match(page.html, /Invitation session expired/);
  assert.doesNotMatch(page.html, /invite link is incomplete/i);
  assert.doesNotMatch(page.html, new RegExp(TOKEN));
});

test("invalid tokens never enter script or deep-link output", () => {
  const page = renderInvitationPage({
    token: `bad\"</script><script>alert(1)</script>`,
    scheme: "zeros-alpha",
    marketingOrigin: "https://zeros.build",
    mode: "web",
    nonce: "testnonce",
  });

  assert.match(page.html, /invite link is incomplete/i);
  assert.doesNotMatch(page.html, /alert\(1\)|\/api\/v1\/invitations\/accept/);
});
