import type { RequestHandler } from 'express';
import { uuidv7 } from 'uuidv7';

const VALID = /^[A-Za-z0-9._-]{8,64}$/;

/** Every request gets a request id (accepted from a trusted proxy, or generated). */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const id = incoming && VALID.test(incoming) ? incoming : uuidv7();
  req.ctx = {
    meta: { requestId: id, ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null },
  };
  res.setHeader('X-Request-Id', id);
  next();
};
