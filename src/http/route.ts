import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { scopeOfPermission } from '../modules/access/authorization.service.js';
import { ErrorResponse, registry } from './openapi.js';
import { parseOrThrow } from './validation.js';

/**
 * public        – no authentication
 * authenticated – valid session in any context (e.g. /auth/me)
 * tenant        – a school context: membership, lifecycle and subscription gates apply
 * platform      – the platform administration context
 */
export type Access = 'public' | 'authenticated' | 'tenant' | 'platform';

type AnyObject = z.ZodObject<z.ZodRawShape>;

export interface RouteDef<P extends AnyObject, Q extends AnyObject, B extends z.ZodType> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  tags: string[];
  access: Access;
  /** All listed permissions are required. Their features are entitlement-checked automatically. */
  permissions?: string[];
  params?: P;
  query?: Q;
  body?: B;
  response?: z.ZodType;
  status?: number;
  rateLimit?: 'auth';
  handler: (input: {
    params: z.infer<P>;
    query: z.infer<Q>;
    body: z.infer<B>;
    req: Request;
    res: Response;
  }) => Promise<unknown>;
}

export interface Pipeline {
  authenticate: RequestHandler;
  resolveContext: (access: Access) => RequestHandler;
  authorize: (permissions: string[]) => RequestHandler;
  authRateLimit: RequestHandler;
}

const Empty = z.object({});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defs: RouteDef<any, any, any>[] = [];

/** Declare a route. Registration also documents it in OpenAPI. */
export function defineRoute<
  P extends AnyObject = typeof Empty,
  Q extends AnyObject = typeof Empty,
  B extends z.ZodType = typeof Empty,
>(def: RouteDef<P, Q, B>): RouteDef<P, Q, B> {
  for (const code of def.permissions ?? []) {
    const scope = scopeOfPermission(code);
    if (!scope)
      throw new Error(
        `Route ${def.method.toUpperCase()} ${def.path} references unknown permission ${code}`,
      );
    if (def.access === 'tenant' && scope !== 'TENANT')
      throw new Error(`Tenant route ${def.path} requires platform permission ${code}`);
    if (def.access === 'platform' && scope !== 'PLATFORM')
      throw new Error(`Platform route ${def.path} requires tenant permission ${code}`);
  }
  if ((def.access === 'tenant' || def.access === 'platform') && !def.permissions?.length) {
    throw new Error(`Route ${def.path} must declare at least one permission`);
  }
  defs.push(def);
  return def;
}

export function allRoutes() {
  return defs;
}

/** Mount routes with the standard pipeline, in the order the architecture mandates. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountRoutes(router: Router, routes: RouteDef<any, any, any>[], pipeline: Pipeline) {
  for (const def of routes) {
    const chain: RequestHandler[] = [];
    if (def.rateLimit === 'auth') chain.push(pipeline.authRateLimit);
    if (def.access !== 'public') {
      chain.push(pipeline.authenticate, pipeline.resolveContext(def.access));
      if (def.permissions?.length) chain.push(pipeline.authorize(def.permissions));
    }
    chain.push(async (req: Request, res: Response, next: NextFunction) => {
      try {
        const params = parseOrThrow(def.params ?? Empty, req.params, 'params');
        const query = parseOrThrow(def.query ?? Empty, req.query, 'query');
        const body = parseOrThrow(def.body ?? Empty, req.body, 'body');
        const result = await def.handler({ params, query, body, req, res });
        if (res.headersSent) return;
        const status = def.status ?? 200;
        if (status === 204 || result === undefined) res.status(status === 200 ? 204 : status).end();
        else res.status(status).json(result);
      } catch (err) {
        next(err);
      }
    });
    router[def.method](def.path, ...chain);
    document(def);
  }
}

const documented = new Set<string>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function document(def: RouteDef<any, any, any>) {
  const key = `${def.method} ${def.path}`;
  if (documented.has(key)) return;
  documented.add(key);
  const permissionNote = def.permissions?.length
    ? `\n\n**Requires:** ${def.permissions.map((p) => `\`${p}\``).join(', ')}`
    : '';
  const accessNote =
    def.access === 'tenant'
      ? '\n\nSchool context. Platform users must send `X-Tenant-Id` and hold `platform.tenants.access`.'
      : '';
  registry.registerPath({
    method: def.method,
    path: def.path.replace(/:([A-Za-z_]+)/g, '{$1}'),
    summary: def.summary,
    description: `Access: **${def.access}**${permissionNote}${accessNote}`,
    tags: def.tags,
    security: def.access === 'public' ? [] : [{ bearerAuth: [] }],
    request: {
      ...(def.params ? { params: def.params } : {}),
      ...(def.query ? { query: def.query } : {}),
      ...(def.body ? { body: { content: { 'application/json': { schema: def.body } } } } : {}),
    },
    responses: {
      [def.status ?? 200]: def.response
        ? { description: 'Success', content: { 'application/json': { schema: def.response } } }
        : { description: 'Success' },
      401: {
        description: 'Authentication required',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      403: {
        description: 'Permission, entitlement or tenant access denied',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      422: {
        description: 'Validation or business-rule error',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  });
}
