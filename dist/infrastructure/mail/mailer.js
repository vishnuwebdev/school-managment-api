/**
 * Development driver: prints the email to the worker log. Message bodies
 * (which contain one-time links) are printed ONLY in development; elsewhere
 * just the metadata is logged, so tokens never end up in log storage.
 */
export class ConsoleMailer {
    log;
    from;
    printBodies;
    constructor(log, from, printBodies) {
        this.log = log;
        this.from = from;
        this.printBodies = printBodies;
    }
    async send(message) {
        const meta = {
            mail: {
                from: this.from,
                to: message.to,
                subject: message.subject,
                template: message.template,
            },
        };
        if (this.printBodies) {
            this.log.info(meta, `\n--- EMAIL ---\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n-------------`);
        }
        else {
            this.log.warn(meta, 'MAIL_DRIVER=console: email not delivered (configure a mail provider)');
        }
    }
}
/** Test driver: keeps sent messages in memory. */
export class MemoryMailer {
    sent = [];
    async send(message) {
        this.sent.push(message);
    }
    clear() {
        this.sent.length = 0;
    }
}
