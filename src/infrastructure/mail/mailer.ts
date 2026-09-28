import type { Logger } from '../../shared/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Template id for providers that support templates, and for tests. */
  template: string;
  data: Record<string, unknown>;
}

/** Provider abstraction: business code depends on this, never on a vendor SDK. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Development driver: prints the email to the worker log. Message bodies
 * (which contain one-time links) are printed ONLY in development; elsewhere
 * just the metadata is logged, so tokens never end up in log storage.
 */
export class ConsoleMailer implements Mailer {
  constructor(
    private readonly log: Logger,
    private readonly from: string,
    private readonly printBodies: boolean,
  ) {}
  async send(message: MailMessage): Promise<void> {
    const meta = {
      mail: {
        from: this.from,
        to: message.to,
        subject: message.subject,
        template: message.template,
      },
    };
    if (this.printBodies) {
      this.log.info(
        meta,
        `\n--- EMAIL ---\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n-------------`,
      );
    } else {
      this.log.warn(meta, 'MAIL_DRIVER=console: email not delivered (configure a mail provider)');
    }
  }
}

/** Test driver: keeps sent messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  clear() {
    this.sent.length = 0;
  }
}
