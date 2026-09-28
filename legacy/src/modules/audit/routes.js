import { Router } from 'express';
import { authenticate, tenantScope, permit } from '../../core/middleware.js';
import { asyncRoute } from '../../core/errors.js';
import { db } from '../../db/index.js';

export const auditRouter = Router();

auditRouter.get('/', authenticate, tenantScope, permit('audit.view'), asyncRoute(async (req, res) => {
  const entries = await db.audit.list(req.tenantId);
  const { target } = req.query;
  res.json({ data: target ? entries.filter((e) => e.target === target) : entries });
}));
