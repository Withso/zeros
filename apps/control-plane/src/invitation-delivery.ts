import {
  inviteEmailHtml,
  sendEmail,
  type EmailConfig,
} from "./email.js";

type InvitationEmailSender = typeof sendEmail;

export type InvitationEmailInput = {
  email: EmailConfig | undefined;
  /** WorkOS owns delivery when its native invitation command is enabled. */
  workosEnabled: boolean;
  destination: string;
  organizationName: string;
  inviterName: string;
  acceptUrl: string;
};

/**
 * Deliver exactly one invitation email.
 *
 * WorkOS sends the branded native invitation in the normal AuthKit path. The
 * custom WorkOS invitation URL enters Zeros' bounded landing page, whose
 * server-side acceptance still enforces exact local correlation and recipient
 * identity. ZeptoMail remains only for the Auth0 rollback path here.
 */
export async function deliverInvitationEmail(
  input: InvitationEmailInput,
  sender: InvitationEmailSender = sendEmail,
): Promise<"provider_owned" | "attempted" | "unconfigured"> {
  if (input.workosEnabled) return "provider_owned";
  if (!input.email) return "unconfigured";
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
