import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '../../shared/logger.js';
import { AppError } from '../../shared/errors.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: `No route for ${req.method} ${req.path}`,
      details: null,
      request_id: req.ctx?.meta.requestId ?? null,
    },
  });
};

/** Maps every error to the standard error contract. Internal details never leak. */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = req.ctx?.meta.requestId ?? null;
    if (err instanceof AppError) {
      if (err.status >= 500) log.error({ err, requestId }, err.message);
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          details: err.details ?? null,
          request_id: requestId,
        },
      });
      return;
    }
    // body-parser errors
    if (err && typeof err === 'object' && 'type' in err) {
      const type = (err as { type: string }).type;
      if (type === 'entity.parse.failed') {
        res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Malformed JSON body',
            details: null,
            request_id: requestId,
          },
        });
        return;
      }
      if (type === 'entity.too.large') {
        res.status(413).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request body is too large',
            details: null,
            request_id: requestId,
          },
        });
        return;
      }
    }
    // A table the code needs isn't in the database: a migration hasn't been
    // applied. Say so instead of a bare 500 (no data leaks: only the table name).
    const missing = missingTable(err);
    if (missing) {
      log.error({ err, requestId }, `Missing table ${missing}: run npm run db:migrate`);
      res.status(503).json({
        error: {
          code: 'DATABASE_NOT_MIGRATED',
          message: `The database is not up to date (table "${missing}" is missing). Run "npm run db:migrate" for the API and try again.`,
          details: { table: missing },
          request_id: requestId,
        },
      });
      return;
    }
    log.error({ err, requestId }, 'Unhandled error');
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        details: null,
        request_id: requestId,
      },
    });
  };
}

/** The table name when [err] (or its cause, as Drizzle wraps driver errors) is MySQL ER_NO_SUCH_TABLE. */
function missingTable(err: unknown): string | null {
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const x = e as { code?: unknown; sqlMessage?: unknown; message?: unknown };
    if (x.code === 'ER_NO_SUCH_TABLE') {
      const text = String(x.sqlMessage ?? x.message ?? '');
      const m = /Table '(?:[^.']+\.)?([^']+)' doesn't exist/.exec(text);
      return m?.[1] ?? 'unknown';
    }
  }
  return null;
}
