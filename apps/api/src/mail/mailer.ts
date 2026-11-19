/** Nest injection token for the configured `Mailer` (console in dev/test, Resend otherwise). */
export const MAILER = Symbol("MAILER");

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}
