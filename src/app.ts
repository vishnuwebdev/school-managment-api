import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Deps } from './container.js';
import { healthRouter } from './http/health.js';
import { errorHandler, notFoundHandler } from './http/middleware/error-handler.js';
import { requestId } from './http/middleware/request-id.js';
import { buildOpenApiDocument } from './http/openapi.js';
import { createPipeline } from './http/pipeline.js';
import { mountRoutes, type RouteDef } from './http/route.js';
import { roleRoutes } from './modules/access/roles.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { catalogRoutes } from './modules/catalog/catalog.routes.js';
import { authRoutes } from './modules/identity/auth.routes.js';
import { memberRoutes, platformUserRoutes } from './modules/members/members.routes.js';
import {
  currentTenantRoutes,
  platformTenantRoutes,
  publicTenantRoutes,
} from './modules/tenants/tenants.routes.js';
import type { Services } from './services.js';

export interface AppOptions {
  /** Extra routes (used by tests to exercise the pipeline). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraRoutes?: RouteDef<any, any, any>[];
}

export function createApp(deps: Deps, svc: Services, opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  if (deps.env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(helmet());
  const origins = deps.env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: origins.length ? origins : false,
      credentials: false,
      exposedHeaders: ['X-Request-Id'],
    }),
  );
  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));
  if (deps.env.NODE_ENV !== 'test') {
    app.use(
      pinoHttp({
        logger: deps.log,
        genReqId: (req) => req.ctx.meta.requestId,
        customProps: (req) => ({
          tenant_id: req.ctx?.tenant?.tenantId,
          user_id: req.ctx?.principal?.userId,
        }),
      }),
    );
  }

  app.use(healthRouter(deps));

  const pipeline = createPipeline(deps, svc);
  const api = Router();
  mountRoutes(
    api,
    [
      ...authRoutes(svc.auth),
      ...publicTenantRoutes(svc.tenants),
      ...currentTenantRoutes(svc.tenants),
      ...memberRoutes(svc.members),
      ...roleRoutes(svc.roles),
      ...catalogRoutes(deps, svc.entitlements),
      ...auditRoutes(deps),
      ...platformTenantRoutes(svc.tenants, svc.entitlements),
      ...platformUserRoutes(svc.members),
      ...(opts.extraRoutes ?? []),
    ],
    pipeline,
  );
  app.use('/api/v1', api);

  const docsEnabled = deps.env.DOCS_ENABLED ?? deps.env.NODE_ENV !== 'production';
  if (docsEnabled) {
    app.get('/openapi.json', (_req, res) => {
      res.json(buildOpenApiDocument());
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler(deps.log));
  return app;
}
