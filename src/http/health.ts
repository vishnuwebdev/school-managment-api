import { Router } from 'express';
import type { Deps } from '../container.js';

/** Liveness stays trivial; readiness checks the dependencies the API needs. */
export function healthRouter(deps: Deps) {
  const router = Router();
  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const ready = async (_req: unknown, res: import('express').Response) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    try {
      await deps.pool.query('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'fail';
    }
    if (deps.redis) {
      try {
        await deps.redis.ping();
        checks.redis = 'ok';
      } catch {
        checks.redis = 'fail';
      }
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', checks });
  };
  router.get('/health/ready', ready);
  router.get('/health', ready);
  return router;
}
