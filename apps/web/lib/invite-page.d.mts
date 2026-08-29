export type InvitationPageMode = "landing" | "web" | "resume";

export declare function renderInvitationPage(options: {
  token: string;
  scheme: string;
  marketingOrigin: string;
  mode: InvitationPageMode;
  nonce: string;
}): { html: string; headers: Headers };
