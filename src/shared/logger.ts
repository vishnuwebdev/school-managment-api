import { pino, type Logger } from 'pino';

/** Structured JSON logs. Secrets are redacted at the logger, not by convention. */
export function createLogger(level: string, pretty = false): Logger {
  return pino({
    level,
    base: { service: 'api' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.new_password',
        '*.current_password',
        '*.refresh_token',
        '*.access_token',
        '*.token',
        '*.passwordHash',
        '*.password_hash',
      ],
      censor: '[REDACTED]',
    },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}

export type { Logger };
