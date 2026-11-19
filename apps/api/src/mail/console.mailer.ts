import { Logger } from "@nestjs/common";
import type { MailMessage, Mailer } from "./mailer.js";

const KEEP = 50;

/**
 * DEV ONLY: logs the email (including its text, which may hold a one-time link)
 * instead of sending it. `loadEnv` refuses `EMAIL_PROVIDER=console` in production.
 * Keeps the last 50 messages in `sent` for tests.
 */
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger(ConsoleMailer.name);
  readonly sent: MailMessage[] = [];

  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    if (this.sent.length > KEEP) this.sent.splice(0, this.sent.length - KEEP);
    this.logger.log(`Email to ${msg.to}: ${msg.subject}\n${msg.text}`);
  }
}
