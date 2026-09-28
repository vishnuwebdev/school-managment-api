import { Router } from 'express';
import { authenticate, tenantScope, permit } from '../../core/middleware.js';
import { asyncRoute, badRequest, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { computeStatus, withStatus, sanitizeNoticePayload, sanitizeAcknowledgementPayload } from './service.js';

// Notices & Communication (edusphere-notices-communication-module-plan-
// 2026-09-22.md). One resource for both the notice board and "direct &
// group messaging" -- a message is just a notice whose audience is
// narrowed to one class/role/individual, since this codebase has no
// parent/student/teacher/staff login for a real inbox to exist. Status is
// always computed (service.js's computeStatus), never trusted from the
// stored row.
export const noticesRouter = Router();

noticesRouter.get('/', authenticate, tenantScope, permit('notices:board:read'), asyncRoute(async (req, res) => {
  const { status, category, audienceType, className, search } = req.query;
  let notices = await db.notices.list(req.tenantId, { category, audienceType, className, search });
  notices = notices.map(withStatus);
  if (status) notices = notices.filter((n) => n.status === status);
  res.json({ data: notices, meta: { total: notices.length } });
}));

noticesRouter.get('/:id', authenticate, tenantScope, permit('notices:board:read'), asyncRoute(async (req, res) => {
  const notice = await db.notices.findById(req.tenantId, req.params.id);
  if (!notice) throw notFound('Notice not found');
  res.json({ data: withStatus(notice) });
}));

noticesRouter.post('/', authenticate, tenantScope, permit('notices:board:write'), asyncRoute(async (req, res) => {
  const clean = sanitizeNoticePayload(req.body);
  const publishNow = req.body?.publish === true;
  const notice = await db.notices.create({
    tenantId: req.tenantId, ...clean, isDraft: !publishNow, isArchived: false, createdBy: req.auth.sub,
  });
  await db.audit.record({
    event: 'notice.created', actorId: req.auth.sub, target: notice.id, tenantId: req.tenantId,
    summary: { title: notice.title, category: notice.category, audienceType: notice.audienceType, publishedImmediately: publishNow },
  });
  res.status(201).json({ data: withStatus(notice) });
}));

noticesRouter.put('/:id', authenticate, tenantScope, permit('notices:board:update'), asyncRoute(async (req, res) => {
  const existing = await db.notices.findById(req.tenantId, req.params.id);
  if (!existing) throw notFound('Notice not found');
  const clean = sanitizeNoticePayload(req.body, { partial: true });
  const notice = await db.notices.update(req.tenantId, req.params.id, clean);
  await db.audit.record({ event: 'notice.updated', actorId: req.auth.sub, target: notice.id, tenantId: req.tenantId, summary: { fields: Object.keys(clean) } });
  res.json({ data: withStatus(notice) });
}));

noticesRouter.post('/:id/publish', authenticate, tenantScope, permit('notices:board:update'), asyncRoute(async (req, res) => {
  const existing = await db.notices.findById(req.tenantId, req.params.id);
  if (!existing) throw notFound('Notice not found');
  if (existing.isArchived) throw badRequest('An archived notice cannot be published -- create a new one instead');
  const notice = await db.notices.update(req.tenantId, req.params.id, { isDraft: false });
  await db.audit.record({ event: 'notice.published', actorId: req.auth.sub, target: notice.id, tenantId: req.tenantId });
  res.json({ data: withStatus(notice) });
}));

noticesRouter.post('/:id/archive', authenticate, tenantScope, permit('notices:board:update'), asyncRoute(async (req, res) => {
  const existing = await db.notices.findById(req.tenantId, req.params.id);
  if (!existing) throw notFound('Notice not found');
  if (existing.isArchived) throw badRequest('This notice is already archived');
  const notice = await db.notices.update(req.tenantId, req.params.id, { isArchived: true });
  await db.audit.record({ event: 'notice.archived', actorId: req.auth.sub, target: notice.id, tenantId: req.tenantId });
  res.json({ data: withStatus(notice) });
}));

// Drafts only -- a notice that was ever published keeps a real trail
// (archive it instead), matching the audit/history discipline every
// other module in this codebase follows (e.g. attendance never deletes,
// only corrects/archives).
noticesRouter.delete('/:id', authenticate, tenantScope, permit('notices:delete:delete'), asyncRoute(async (req, res) => {
  const existing = await db.notices.findById(req.tenantId, req.params.id);
  if (!existing) throw notFound('Notice not found');
  if (!existing.isDraft) throw badRequest('Only a draft notice can be deleted -- archive it instead to keep a record');
  await db.notices.remove(req.tenantId, req.params.id);
  await db.audit.record({ event: 'notice.deleted', actorId: req.auth.sub, target: req.params.id, tenantId: req.tenantId, summary: { title: existing.title } });
  res.status(204).send();
}));

noticesRouter.get('/:id/acknowledgements', authenticate, tenantScope, permit('notices:acknowledgements:read'), asyncRoute(async (req, res) => {
  const existing = await db.notices.findById(req.tenantId, req.params.id);
  if (!existing) throw notFound('Notice not found');
  const data = await db.noticeAcknowledgements.listForNotice(req.tenantId, req.params.id);
  res.json({ data, meta: { total: data.length } });
}));

noticesRouter.post('/:id/acknowledgements', authenticate, tenantScope, permit('notices:acknowledgements:write'), asyncRoute(async (req, res) => {
  const existing = await db.notices.findById(req.tenantId, req.params.id);
  if (!existing) throw notFound('Notice not found');
  if (computeStatus(existing) === 'draft') throw badRequest('Cannot record an acknowledgement for a notice that has not been published yet');
  const clean = sanitizeAcknowledgementPayload(req.body);
  const ack = await db.noticeAcknowledgements.create({ tenantId: req.tenantId, noticeId: req.params.id, ...clean, recordedBy: req.auth.sub });
  await db.audit.record({ event: 'notice.acknowledgementRecorded', actorId: req.auth.sub, target: existing.id, tenantId: req.tenantId, summary: { recipientLabel: clean.recipientLabel, method: clean.method } });
  res.status(201).json({ data: ack });
}));
