import type { z } from 'zod';
import { ValidationError } from '../shared/errors.js';

export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  where: 'body' | 'query' | 'params',
): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ValidationError('The request is invalid', {
      location: where,
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
    });
  }
  return result.data;
}
