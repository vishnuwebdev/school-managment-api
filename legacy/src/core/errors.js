// Small, deliberate error type so route handlers can throw something
// meaningful and a single error middleware turns it into a consistent,
// human-readable API response (spec section 42: no stack traces to users).
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const notFound = (message = 'Not found') => new AppError(404, message);
export const badRequest = (message = 'Invalid request') => new AppError(422, message);
export const conflict = (message = 'Conflict') => new AppError(409, message);
export const forbidden = (message = 'Permission denied') => new AppError(403, message);
export const unauthorized = (message = 'Authentication required') => new AppError(401, message);

// Wraps an async route handler so a thrown/rejected error reaches Express's
// error middleware instead of crashing the process or hanging the request.
export const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export const errorMiddleware = (err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err); // eslint-disable-line no-console
  res.status(status).json({ error: err.message || 'Unexpected server error' });
};
