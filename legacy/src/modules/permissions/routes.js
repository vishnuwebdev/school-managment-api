import { Router } from 'express';
import { authenticate, tenantScope, permit } from '../../core/middleware.js';
import { asyncRoute } from '../../core/errors.js';
import { FEATURE_CATALOG } from '../../core/permissionsV2.js';

// A single, real source of truth for the new feature:page:action catalog,
// served to the Flutter app instead of being hand-copied there. Before
// this route existed, users_roles_screen.dart and
// school_entitlements_screen.dart each kept their OWN small, hardcoded
// subset of FEATURE_CATALOG (originally just Dashboard + School Setup),
// which silently fell behind every time another module migrated -- by
// the time Users/Roles itself was migrated, seven modules' worth of real,
// already-enforced permissions had no editor anywhere in the UI. This
// endpoint removes that duplication at the source: any screen that needs
// to render or edit the permission tree fetches it from here, so a
// future module's migration (adding one entry to FEATURE_CATALOG) is
// automatically reflected in every screen that uses this endpoint, with
// no Flutter change required.
//
// Gated on users:roles:read (view the Roles & permissions page) rather
// than left open to any authenticated user -- the catalog itself isn't
// sensitive, but which permissions exist is only useful to someone who
// can actually grant them, and this keeps the gate consistent with the
// screen that consumes it.
export const permissionsRouter = Router();

permissionsRouter.get('/catalog', authenticate, tenantScope, permit('users:roles:read'), asyncRoute(async (_req, res) => {
  const features = Object.entries(FEATURE_CATALOG).map(([featureKey, feature]) => ({
    key: featureKey,
    label: feature.label,
    pages: Object.entries(feature.pages).map(([pageKey, page]) => ({
      key: pageKey,
      label: page.label,
      actions: page.actions,
    })),
  }));
  res.json({ data: features });
}));
