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
