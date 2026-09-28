import { Router } from 'express';
import { authenticate, tenantScope, permit } from '../../core/middleware.js';
import { asyncRoute } from '../../core/errors.js';

// Dashboard has no data of its own -- the Flutter screen composes it
// entirely from existing students/attendance reads (see
// dashboard_providers.dart). That left it as the one screen in the app
// with no server-side access control point at all: any authenticated
// user could load it regardless of role. This route exists solely to
// give the new dashboard:overview:read permission (and the school's
// Dashboard feature entitlement) a real backend enforcement point,
// rather than leaving Dashboard access as a client-only nav hide. The
// Flutter dashboard screen calls this alongside its existing calls; a
// 403 here surfaces the same way any other failed call does.
export const dashboardRouter = Router();

dashboardRouter.get('/access', authenticate, tenantScope, permit('dashboard:overview:read'), asyncRoute(async (_req, res) => {
  res.json({ data: { ok: true } });
}));
