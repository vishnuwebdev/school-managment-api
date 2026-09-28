import { Router } from 'express';
import { asyncRoute, badRequest } from '../../core/errors.js';
import { login, devLogin } from './service.js';

export const authRouter = Router();

authRouter.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw badRequest('email and password are required');
  res.json(await login({ email, password }));
}));

// Kept only for local development speed (see service.js). Production
// deployments should set ALLOW_DEV_LOGIN=false.
authRouter.post('/dev-login', asyncRoute(async (req, res) => {
  res.json(await devLogin({ role: req.body?.role }));
}));

// Stateless JWTs have nothing to revoke server-side yet (no session store);
// this endpoint exists so the client has a real logout call to make and a
// place to plug in token revocation / refresh-token invalidation later.
authRouter.post('/logout', (_req, res) => res.status(204).send());
