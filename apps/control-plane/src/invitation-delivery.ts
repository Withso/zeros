import {
  inviteEmailHtml,
  sendEmail,
  type EmailConfig,
} from "./email.js";

type InvitationEmailSender = typeof sendEmail;

export type InvitationEmailInput = {
  email: EmailConfig | undefined;
  /** Provider synchronization does not own the product capability email. */
  workosEnabled: boolean;
  destination: string;
  organizationName: string;
  inviterName: string;
  acceptUrl: string;
};

/**
 * Deliver the single Zeros-owned invitation capability email.
 *
 * WorkOS may mirror a pending provider invitation, but its default invitation
 * email must remain disabled: that link enters Hosted AuthKit without Zeros'
 * state/PKCE flow or the exact local capability. Keeping this policy in one
 * provider-aware function prevents a future auth-provider branch from
 * suppressing the application-owned email again.
 */
export async function deliverInvitationEmail(
  input: InvitationEmailInput,
  sender: InvitationEmailSender = sendEmail,
): Promise<"attempted" | "unconfigured"> {
  if (!input.email) return "unconfigured";

  // Deliberately read the flag even though both provider modes share the same
  // sender. The invariant is that enabling WorkOS never changes email owner.
  void input.workosEnabled;
  const message = inviteEmailHtml({
    organizationName: input.organizationName,
    inviterName: input.inviterName,
    acceptUrl: input.acceptUrl,
    expiresDays: 7,
  });
  await sender(
    input.email,
    input.destination,
    message.subject,
    message.html,
  );
  return "attempted";
}
