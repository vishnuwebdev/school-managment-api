import { db } from '../../db/index.js';
import { computePercentage } from '../attendance/service.js';
import { getStudentBalance } from '../fees/service.js';
import { badRequest, notFound } from '../../core/errors.js';

// Parent Registry (see the "Parent Registry Blueprint" plan artifact,
// 2026-09-20). Builds against the still-unbuilt parents.view/.create/
// .update permissions that have sat reserved and unused in
// core/permissions.js since the Student Management module was built --
// see modules/students/routes.js's own header comment pointing here.
//
// Two real tables (schema.sql's Parent Registry header): `parents` (one
// row per real parent/guardian) and `parent_student_links` (the many-to-
// many join, carrying relationship + contact-flag data per child). The
// existing `students.guardians` JSON column is left completely alone --
// every screen that already reads it (student profile, admission form)
// keeps working unchanged. A one-time (safe to re-run) backfill migrates
// each student's guardians{} into real parents + links, deduping by
// phone/email exactly like the interactive Add/Link flow does, so a
// parent shared by two siblings collapses into one record instead of two.

const RELATIONSHIPS = new Set(['father', 'mother', 'guardian', 'other']);

export const normalizePhone = (value) => (typeof value === 'string' ? value.replace(/[^\d+]/g, '') : '');
export const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export function sanitizeParentPayload(body, { partial = false } = {}) {
  body = body || {};
  const clean = {};

  if (!partial || body.fullName !== undefined) {
    if (!body.fullName || typeof body.fullName !== 'string' || !body.fullName.trim()) throw badRequest('fullName is required');
    clean.fullName = body.fullName.trim();
  }
  if (body.phone !== undefined) {
    if (!body.phone || typeof body.phone !== 'string' || !body.phone.trim()) throw badRequest('phone is required');
    clean.phone = body.phone.trim();
  } else if (!partial) {
    throw badRequest('phone is required');
  }
  for (const key of ['email', 'address', 'occupation']) {
    if (typeof body[key] === 'string') clean[key] = body[key].trim();
  }
  if (body.portalAccess !== undefined) clean.portalAccess = Boolean(body.portalAccess);
  return clean;
}

export function sanitizeLinkPayload(body) {
  const { studentId, relationship, isPrimaryContact = false, isEmergencyContact = false } = body || {};
  if (!studentId || typeof studentId !== 'string') throw badRequest('studentId is required');
  if (!RELATIONSHIPS.has(relationship)) throw badRequest(`relationship must be one of: ${[...RELATIONSHIPS].join(', ')}`);
  return { studentId, relationship, isPrimaryContact: Boolean(isPrimaryContact), isEmergencyContact: Boolean(isEmergencyContact) };
}

// The dedupe check behind "Search by phone / email" (blueprint 03) --
// an exact match on normalized phone OR case-insensitive email. Returns
// every match rather than assuming there's only ever one, since two
// admins could in theory have already created near-duplicates before
// this module existed to prevent it.
export async function dedupeSearch(tenantId, { phone, email }) {
  const normPhone = normalizePhone(phone);
  const normEmail = normalizeEmail(email);
  if (!normPhone && !normEmail) return [];
  const all = await db.parents.list(tenantId, {});
  return all.filter((p) => p.status !== 'merged' && (
    (normPhone && normalizePhone(p.phone) === normPhone) ||
    (normEmail && normalizeEmail(p.email) === normEmail)
  ));
}

// One parent's linked children, enriched with the read-only cross-module
// summary the Overview tab shows (blueprint 04): attendance % and fee
// balance are both real, computed live from Attendance's and Fees'
// existing per-student data -- nothing new is stored here, this module
// only ever reads those two.
export async function linkedChildrenFor(tenantId, parentId) {
  const links = await db.parentStudentLinks.list(tenantId, { parentId });
  const children = [];
  for (const link of links) {
    const student = await db.students.findById(tenantId, link.studentId);
    if (!student) continue; // a since-deleted student -- skip rather than crash the profile
    const history = await db.attendance.findByStudent(tenantId, student.id);
    const attendancePct = computePercentage(history);
    let feeBalance = null;
    try {
      feeBalance = (await getStudentBalance(tenantId, student.id)).owed;
    } catch {
      feeBalance = null; // Fees module has nothing for this student yet -- an honest null, not a fabricated 0
    }
    children.push({
      linkId: link.id, studentId: student.id, name: `${student.firstName} ${student.lastName}`,
      admissionNumber: student.admissionNumber, className: student.className, section: student.section,
      status: student.status, relationship: link.relationship, isPrimaryContact: link.isPrimaryContact,
      isEmergencyContact: link.isEmergencyContact, attendancePct, feeBalance,
    });
  }
  return children;
}

export async function enrichParent(tenantId, parent) {
  return { ...parent, linkedChildren: await linkedChildrenFor(tenantId, parent.id) };
}

export async function requireParent(tenantId, parentId) {
  const parent = await db.parents.findById(tenantId, parentId);
  if (!parent || parent.status === 'merged') throw notFound('Parent not found');
  return parent;
}

// --- Merge duplicates (blueprint 04/06 -- genuinely new work, no other
// module in this codebase merges two records of the same entity) ---
//
// Kept deliberately simple and honest: every parent_student_links row on
// `mergeId` is repointed at `keepId` (skipping any student the keeper is
// already linked to, so a child is never linked twice to the same
// parent), then `mergeId` is marked status: 'merged' with a mergedInto
// pointer rather than hard-deleted, so it drops out of search/registry
// results but the audit trail survives. `keepId`'s own contact fields are
// never touched -- this does not let an admin pick and choose which
// phone/email/address "wins" field by field, which would need its own,
// more careful UI. That's a real scope simplification, not an oversight.
export async function mergeParents(tenantId, actorId, keepId, mergeId) {
  if (keepId === mergeId) throw badRequest('Cannot merge a parent into itself');
  const keep = await requireParent(tenantId, keepId);
  const merge = await requireParent(tenantId, mergeId);
  const keepLinks = await db.parentStudentLinks.list(tenantId, { parentId: keep.id });
  const keepStudentIds = new Set(keepLinks.map((l) => l.studentId));
  const mergeLinks = await db.parentStudentLinks.list(tenantId, { parentId: merge.id });
  let movedCount = 0, droppedCount = 0;
  for (const link of mergeLinks) {
    if (keepStudentIds.has(link.studentId)) { await db.parentStudentLinks.remove(tenantId, link.id); droppedCount++; continue; }
    await db.parentStudentLinks.update(tenantId, link.id, { parentId: keep.id });
    movedCount++;
  }
  const updated = await db.parents.update(tenantId, merge.id, { status: 'merged', mergedInto: keep.id, updatedAt: new Date().toISOString() });
  await db.audit.record({ event: 'parents.merged', actorId, target: keep.id, tenantId, summary: { mergedId: merge.id, movedCount, droppedCount } });
  return { keep: await enrichParent(tenantId, keep), merged: updated, movedCount, droppedCount };
}

// --- Backfill (blueprint 02 -- optional, safe to re-run) ---
//
// Reads every student's guardians{father,mother,guardian} JSON and turns
// each real contact into a parent + parent_student_links row, deduping
// against parents that already exist (created by a prior run of this
// same backfill, or by an admin using Add/Link Parent by hand) by phone
// first, then email. A contact with neither a phone nor an email is
// skipped -- there's nothing to safely dedupe it against, and creating an
// unreachable "parent" record would just be clutter. Deliberately keeps
// no separate "already migrated" flag on the student (that would mean
// altering the students table this module has promised to leave alone) --
// the dedupe-by-phone/email lookup plus the per-student existing-link
// check below are already enough to make re-running this a true no-op:
// a guardian that was migrated last time is found again by its phone/
// email, its link already exists, and nothing new is created.
export async function backfillFromGuardians(tenantId, actorId) {
  const students = await db.students.list(tenantId, {});
  let studentsProcessed = 0, parentsCreated = 0, parentsReused = 0, linksCreated = 0, contactsSkipped = 0;

  for (const student of students) {
    const guardians = student.guardians || {};
    for (const relationship of ['father', 'mother', 'guardian']) {
      const contact = guardians[relationship];
      if (!contact || !contact.name) continue;
      if (!contact.phone && !contact.email) { contactsSkipped++; continue; }

      const matches = await dedupeSearch(tenantId, { phone: contact.phone, email: contact.email });
      let parent = matches[0] || null;
      if (parent) {
        parentsReused++;
      } else {
        parent = await db.parents.create({
          tenantId, fullName: contact.name, phone: contact.phone || '', email: contact.email || '',
          address: contact.address || '', occupation: '', portalAccess: false, status: 'active',
        });
        parentsCreated++;
      }
      const existingLink = (await db.parentStudentLinks.list(tenantId, { parentId: parent.id })).find((l) => l.studentId === student.id);
      if (!existingLink) {
        await db.parentStudentLinks.create({
          tenantId, parentId: parent.id, studentId: student.id, relationship,
          isPrimaryContact: relationship === 'father', isEmergencyContact: relationship === 'father',
        });
        linksCreated++;
      }
    }
    studentsProcessed++;
  }

  await db.audit.record({ event: 'parents.backfillRun', actorId, target: tenantId, tenantId, summary: { studentsProcessed, parentsCreated, parentsReused, linksCreated, contactsSkipped } });
  return { studentsProcessed, parentsCreated, parentsReused, linksCreated, contactsSkipped };
}
