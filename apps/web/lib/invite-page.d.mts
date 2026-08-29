export type InvitationPageMode = "landing" | "web" | "resume";

export declare function invitationTokenFromSearchParams(
  searchParams: URLSearchParams,
): {
  token: string;
  tokenParameter: "token" | "invitation_token";
};

export declare function renderInvitationPage(options: {
  token: string;
  tokenParameter?: "token" | "invitation_token";
  scheme: string;
  marketingOrigin: string;
  mode: InvitationPageMode;
  nonce: string;
}): { html: string; headers: Headers };
