import { waitForNativeRenderer } from "./design-native-renderer.mjs";

// Authentication gates BridgeProvider in the ordinary Dev app. Read only the
// normal authorization result before waiting for a bridge that cannot mount
// while signed out. Session material and the Me document stay in the renderer.
export async function waitForNativeOwnerAccess(page, timeout = 30_000) {
  if (await page.evaluate(() => globalThis.window.__ZEROS_NATIVE__?.localDevelopment !== false))
    throw new Error("Organization qualification requires ordinary Dev authorization, not account-free Local mode.");
  const membership = await page.evaluate(async () => {
    const { getSession } = await import("/apps/desktop/src/renderer/features/auth/auth-store.ts");
    const signedIn = Boolean(await getSession());
    if (!signedIn) return { signedIn, organizationId: null };
    const { refreshTeams } = await import("/apps/desktop/src/renderer/features/team/team-store.ts");
    const me = await refreshTeams();
    return { signedIn, organizationId: (me?.organizations ?? me?.teams ?? []).find(owner => !owner.isPersonal)?.id ?? null };
  });
  const blocked = membership.organizationId ? null : membership.signedIn
    ? "The normal Dev account returned no organization membership."
    : "The primary Alpha Dev profile has no usable signed-in session.";
  if (!blocked) await waitForNativeRenderer(page, async () =>
    (await import("/apps/desktop/src/renderer/platform/bridge/active-bridge.ts")).getActiveBridge()?.status === "connected",
  undefined, timeout);
  return { ...membership, blocked };
}

/** Owner data is not an authorization grant. Await the actual selected owner
 * before a workspace intent, including its remembered-route publication. */
export async function selectNativeOwner(page, workspace, timeout = 30_000) {
  await page.evaluate(async workspace => {
    const { getTeamStoreState } = await import("/apps/desktop/src/renderer/features/team/team-store.ts");
    if (workspace.organizationId && !(getTeamStoreState().me?.organizations ?? getTeamStoreState().me?.teams ?? [])
      .some(owner => owner.id === workspace.organizationId && !owner.isPersonal))
      throw new Error("The selected fixture owner no longer has normal membership.");
    const { setActiveOrganizationSelection } = await import("/apps/desktop/src/renderer/features/team/active-team.ts");
    setActiveOrganizationSelection(workspace.organizationId ?? "local-personal", !workspace.organizationId);
  }, workspace);
  await waitForNativeRenderer(page, async workspace => {
    const { getActiveOrganizationSnapshot } = await import("/apps/desktop/src/renderer/features/team/team-store.ts");
    return getActiveOrganizationSnapshot()?.id === (workspace.organizationId ?? "local-personal");
  }, workspace, timeout).catch(cause => {
    throw new Error("Native fixture owner did not become active.", { cause });
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
