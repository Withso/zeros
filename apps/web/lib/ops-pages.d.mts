export declare const OPS_ASSET_REVISION: string;
export declare function opsPolicy(nonces?: {
  styleNonce?: string | null;
  scriptNonce?: string | null;
}): string;
export declare function opsStatePage(
  kind: "signIn" | "reauthenticate" | "denied" | "unavailable",
  input: { href: string; nonce: string },
): string;
export declare function opsConsolePage(input: {
  session: {
    user: {
      id: string;
      displayName: string | null;
      email: string;
      role: "platform_owner" | "developer";
    };
    deploymentChannel: "development" | "alpha" | "production";
  };
  section: string | null;
  signOutHref: string;
  nonce: string;
}): string;
