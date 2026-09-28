import { asc, desc, type AnyColumn, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ValidationError } from './errors.js';

export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
  sort: z.string().max(50).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

export interface Page<T> {
  data: T[];
  meta: { page: number; page_size: number; total: number };
}

export function pageOf<T>(
  data: T[],
  total: number,
  q: Pick<PaginationQuery, 'page' | 'page_size'>,
): Page<T> {
  return { data, meta: { page: q.page, page_size: q.page_size, total } };
}

export const offsetOf = (q: Pick<PaginationQuery, 'page' | 'page_size'>) =>
  (q.page - 1) * q.page_size;

/**
 * Resolve `?sort=<field>&order=asc|desc` against an allow-list of columns.
 * Unknown fields are rejected rather than silently ignored.
 */
export function orderFrom<C extends AnyColumn>(
  q: Pick<PaginationQuery, 'sort' | 'order'>,
  allowed: Record<string, C>,
  fallback: string,
): SQL {
  const key = q.sort ?? fallback;
  const column = allowed[key];
  if (!column) {
    throw new ValidationError('The request is invalid', {
      location: 'query',
      issues: [
        {
          path: 'sort',
          code: 'invalid_value',
          message: `Sort by one of: ${Object.keys(allowed).join(', ')}`,
        },
      ],
    });
  }
  return q.order === 'asc' ? asc(column) : desc(column);
}
