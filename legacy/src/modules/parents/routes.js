import { Router } from 'express';
import multer from 'multer';
import { authenticate, tenantScope, permit } from '../../core/middleware.js';
import { asyncRoute, badRequest, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { parseCsv, toCsv } from '../../core/csv.js';
import {
  sanitizeParentPayload, sanitizeLinkPayload, dedupeSearch, enrichParent, linkedChildrenFor,
  requireParent, mergeParents, backfillFromGuardians,
} from './service.js';

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

// Parent Registry -- see service.js's header for the full design
// rationale and the "Parent Registry Blueprint" plan artifact
// (2026-09-20) this module builds against.
//
// Permissions here use the new-format parents:<page>:<action> catalog
// (core/permissionsV2.js) -- see that file's FEATURE_CATALOG entry for
// the full page/action breakdown. Unlike every other module migrated so
// far, this one is NOT a zero-regression change for sub_admin: seed.js
// already grants sub_admin the old parents.view/parents.create keys, so
// it keeps registry/profile read and add-link/import write through the
// OLD_TO_NEW compat bridge, and correctly still lacks merge/profile
// update access, exactly as before.
export const parentsRouter = Router();

// --- Registry (list/search) ---

parentsRouter.get('/', authenticate, tenantScope, permit('parents:registry:read'), asyncRoute(async (req, res) => {
  const { q = '' } = req.query;
  const query = q.toLowerCase().trim();
  const all = (await db.parents.list(req.tenantId, {})).filter((p) => p.status !== 'merged');
  const filtered = query
    ? all.filter((p) => `${p.fullName} ${p.phone} ${p.email}`.toLowerCase().includes(query))
    : all;
  const withCounts = await Promise.all(filtered.map(async (p) => {
    const links = await db.parentStudentLinks.list(req.tenantId, { parentId: p.id });
    return { ...p, linkedChildrenCount: links.length };
  }));
  res.json({ data: withCounts, meta: { total: withCounts.length } });
}));

// Dedupe search (blueprint 03's "Search by phone / email") -- ahead of
// /:id so "dedupe" is never read as a parent id, same convention as
// students' own import routes.
parentsRouter.get('/dedupe', authenticate, tenantScope, permit('parents:registry:read'), asyncRoute(async (req, res) => {
  const { phone, email } = req.query;
  if (!phone && !email) throw badRequest('phone or email is required');
  const matches = await dedupeSearch(req.tenantId, { phone, email });
  res.json({ data: matches });
}));

// --- Bulk import (mirrors students' import/preview + import/commit
// pattern exactly, per blueprint 06) ---

const IMPORT_TEMPLATE_HEADERS = ['fullName', 'phone', 'email', 'address', 'occupation', 'studentAdmissionNumber', 'relationship'];

parentsRouter.get('/import/template', authenticate, tenantScope, permit('parents:import:write'), asyncRoute(async (req, res) => {
  const example = { fullName: 'Rajesh Sharma', phone: '+91 98765 43210', email: 'rajesh.sharma@email.com', address: '', occupation: 'Engineer', studentAdmissionNumber: 'BFS001', relationship: 'father' };
  const csv = toCsv(IMPORT_TEMPLATE_HEADERS, [example]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="parent_import_template.csv"');
  res.send(csv);
}));

parentsRouter.post('/import/preview', authenticate, tenantScope, permit('parents:import:write'), upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw badRequest('A CSV file is required');
  const records = parseCsv(req.file.buffer.toString('utf-8'));
  const rows = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const rowNumber = i + 2;
    try {
      if (!record.fullName?.trim()) throw new Error('fullName is missing');
      if (!record.phone?.trim() && !record.email?.trim()) throw new Error('At least one of phone or email is required');
      let student = null;
      if (record.studentAdmissionNumber?.trim()) {
        const matches = await db.students.list(req.tenantId, { query: '' });
        student = matches.find((s) => s.admissionNumber === record.studentAdmissionNumber.trim());
        if (!student) throw new Error(`No student with admission number "${record.studentAdmissionNumber}"`);
        if (!['father', 'mother', 'guardian', 'other'].includes((record.relationship || '').trim())) {
          throw new Error('relationship must be one of: father, mother, guardian, other (required whenever studentAdmissionNumber is set)');
        }
      }
      const existingMatches = await dedupeSearch(req.tenantId, { phone: record.phone, email: record.email });
      rows.push({
        row: rowNumber, status: 'Valid', message: existingMatches.length ? `Will link to existing parent "${existingMatches[0].fullName}"` : 'Will create a new parent', fullName: record.fullName.trim(),
        payload: { fullName: record.fullName.trim(), phone: record.phone?.trim() || '', email: record.email?.trim() || '', address: record.address?.trim() || '', occupation: record.occupation?.trim() || '' },
        link: student ? { studentId: student.id, relationship: record.relationship.trim() } : null,
        existingParentId: existingMatches[0]?.id || null,
      });
    } catch (error) {
      rows.push({ row: rowNumber, status: 'Error', message: error.message, fullName: record.fullName || null, payload: null, link: null, existingParentId: null });
    }
  }
  const validCount = rows.filter((r) => r.status === 'Valid').length;
  res.json({ data: { totalRecords: rows.length, validRecords: validCount, invalidRecords: rows.length - validCount, rows } });
}));

parentsRouter.post('/import/commit', authenticate, tenantScope, permit('parents:import:write'), asyncRoute(async (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows) || !rows.length) throw badRequest('rows must be a non-empty array of previewed payloads');
  let created = 0, linked = 0;
  const skipped = [];
  for (const row of rows) {
    if (!row?.payload?.fullName) { skipped.push({ reason: 'Missing payload' }); continue; }
    let parent;
    if (row.existingParentId) {
      parent = await db.parents.findById(req.tenantId, row.existingParentId);
      if (!parent) { skipped.push({ fullName: row.payload.fullName, reason: 'Existing parent no longer found' }); continue; }
    } else {
      parent = await db.parents.create({ tenantId: req.tenantId, ...row.payload, portalAccess: false, status: 'active' });
      created++;
    }
    if (row.link?.studentId) {
      const existingLink = (await db.parentStudentLinks.list(req.tenantId, { parentId: parent.id })).find((l) => l.studentId === row.link.studentId);
      if (!existingLink) {
        await db.parentStudentLinks.create({ tenantId: req.tenantId, parentId: parent.id, studentId: row.link.studentId, relationship: row.link.relationship, isPrimaryContact: false, isEmergencyContact: false });
        linked++;
      }
    }
  }
  await db.audit.record({ event: 'parents.imported', actorId: req.auth.sub, target: 'bulk', tenantId: req.tenantId, summary: { created, linked } });
  res.status(201).json({ data: { created, linked, skipped } });
}));

// Backfill (blueprint 02, optional, safe to re-run) -- migrates every
// student's guardians{} JSON into real parents + links. Exposed as a real
// route rather than only a one-off script, gated the same as any other
// bulk-create action.
parentsRouter.post('/backfill', authenticate, tenantScope, permit('parents:import:write'), asyncRoute(async (req, res) => {
  const result = await backfillFromGuardians(req.tenantId, req.auth.sub);
  res.status(201).json({ data: result });
}));

// --- Merge duplicates (blueprint 04/06) -- ahead of /:id for the same
// reason /dedupe and /import/* are. ---

parentsRouter.post('/merge', authenticate, tenantScope, permit('parents:merge:update'), asyncRoute(async (req, res) => {
  const { keepId, mergeId } = req.body || {};
  if (!keepId || !mergeId) throw badRequest('keepId and mergeId are required');
  const result = await mergeParents(req.tenantId, req.auth.sub, keepId, mergeId);
  res.json({ data: result });
}));

// --- Links (create/update/remove a parent<->student relationship) ---

parentsRouter.post('/:id/links', authenticate, tenantScope, permit('parents:add-link:write'), asyncRoute(async (req, res) => {
  const parent = await requireParent(req.tenantId, req.params.id);
  const payload = sanitizeLinkPayload(req.body);
  const student = await db.students.findById(req.tenantId, payload.studentId);
  if (!student) throw notFound('Student not found');
  const existing = (await db.parentStudentLinks.list(req.tenantId, { parentId: parent.id })).find((l) => l.studentId === payload.studentId);
  if (existing) throw badRequest('This parent is already linked to this student');
  const link = await db.parentStudentLinks.create({ tenantId: req.tenantId, parentId: parent.id, ...payload });
  await db.audit.record({ event: 'parents.linked', actorId: req.auth.sub, target: parent.id, tenantId: req.tenantId, summary: { studentId: payload.studentId, relationship: payload.relationship } });
  res.status(201).json({ data: link });
}));

parentsRouter.put('/links/:linkId', authenticate, tenantScope, permit('parents:profile:update'), asyncRoute(async (req, res) => {
  const existing = await db.parentStudentLinks.findById(req.tenantId, req.params.linkId);
  if (!existing) throw notFound('Link not found');
  const { relationship, isPrimaryContact, isEmergencyContact } = req.body || {};
  const patch = {};
  if (relationship !== undefined) {
    if (!['father', 'mother', 'guardian', 'other'].includes(relationship)) throw badRequest('relationship must be one of: father, mother, guardian, other');
    patch.relationship = relationship;
  }
  if (isPrimaryContact !== undefined) patch.isPrimaryContact = Boolean(isPrimaryContact);
  if (isEmergencyContact !== undefined) patch.isEmergencyContact = Boolean(isEmergencyContact);
  const link = await db.parentStudentLinks.update(req.tenantId, req.params.linkId, patch);
  await db.audit.record({ event: 'parents.linkUpdated', actorId: req.auth.sub, target: existing.parentId, tenantId: req.tenantId });
  res.json({ data: link });
}));

parentsRouter.delete('/links/:linkId', authenticate, tenantScope, permit('parents:profile:update'), asyncRoute(async (req, res) => {
  const existing = await db.parentStudentLinks.findById(req.tenantId, req.params.linkId);
  if (!existing) throw notFound('Link not found');
  await db.parentStudentLinks.remove(req.tenantId, req.params.linkId);
  await db.audit.record({ event: 'parents.unlinked', actorId: req.auth.sub, target: existing.parentId, tenantId: req.tenantId, summary: { studentId: existing.studentId } });
  res.status(204).end();
}));

// --- Profile (screen: Parent Profile, overview/contact/comms/portal tabs) ---

parentsRouter.get('/:id', authenticate, tenantScope, permit('parents:profile:read'), asyncRoute(async (req, res) => {
  const parent = await requireParent(req.tenantId, req.params.id);
  res.json({ data: await enrichParent(req.tenantId, parent) });
}));

parentsRouter.post('/', authenticate, tenantScope, permit('parents:add-link:write'), asyncRoute(async (req, res) => {
  const clean = sanitizeParentPayload(req.body);
  const parent = await db.parents.create({ tenantId: req.tenantId, ...clean, occupation: clean.occupation || '', address: clean.address || '', email: clean.email || '', portalAccess: false, status: 'active' });
  await db.audit.record({ event: 'parents.created', actorId: req.auth.sub, target: parent.id, tenantId: req.tenantId, summary: { fullName: parent.fullName } });
  res.status(201).json({ data: parent });
}));

parentsRouter.put('/:id', authenticate, tenantScope, permit('parents:profile:update'), asyncRoute(async (req, res) => {
  await requireParent(req.tenantId, req.params.id);
  const clean = sanitizeParentPayload(req.body, { partial: true });
  const parent = await db.parents.update(req.tenantId, req.params.id, { ...clean, updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'parents.updated', actorId: req.auth.sub, target: parent.id, tenantId: req.tenantId });
  res.json({ data: parent });
}));

parentsRouter.post('/:id/deactivate', authenticate, tenantScope, permit('parents:profile:update'), asyncRoute(async (req, res) => {
  await requireParent(req.tenantId, req.params.id);
  const parent = await db.parents.update(req.tenantId, req.params.id, { status: 'inactive', updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'parents.deactivated', actorId: req.auth.sub, target: parent.id, tenantId: req.tenantId });
  res.json({ data: parent });
}));

parentsRouter.post('/:id/reactivate', authenticate, tenantScope, permit('parents:profile:update'), asyncRoute(async (req, res) => {
  await requireParent(req.tenantId, req.params.id);
  const parent = await db.parents.update(req.tenantId, req.params.id, { status: 'active', updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'parents.reactivated', actorId: req.auth.sub, target: parent.id, tenantId: req.tenantId });
  res.json({ data: parent });
}));

// Portal tab's "Enable portal access" toggle (blueprint 06) -- saved for
// real, but honestly does nothing yet: there is no parent-login concept
// anywhere in this codebase (same gap the teacher portal has). Reuses the
// generic PUT above rather than a separate endpoint, since it's just
// another field on the same record.
