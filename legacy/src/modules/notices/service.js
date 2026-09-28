import { badRequest } from '../../core/errors.js';

// Notices & Communication -- business rules shared by routes.js.
// See edusphere-notices-communication-module-plan-2026-09-22.md for the
// architecture this follows: one resource covers both the notice board
// and "direct & group messaging" (a message is just a notice narrowed to
// a small audience), and status is always computed from dates rather than
// stored, since nothing in this codebase runs a background job that could
// keep a stored status in sync.

export const CATEGORIES = ['notice', 'circular', 'announcement', 'event'];
export const AUDIENCE_TYPES = ['entire_school', 'role', 'class', 'individual'];
export const AUDIENCE_ROLES = ['teacher', 'staff', 'student', 'parent'];
export const RECIPIENT_TYPES = ['student', 'staff', 'parent'];
export const ACK_METHODS = ['phone', 'in_person', 'paper', 'other'];

const isValidIsoDateTime = (value) => typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));

// A notice's status is derived, never stored, so it can never drift out
// of sync with a publish/expiry date that has simply passed:
//   archived  -- manually retired by an admin, regardless of dates
//   draft     -- not yet published (is_draft still true)
//   scheduled -- published, but publish_at is still in the future
//   expired   -- expiry_at has passed
//   published -- publish_at has passed and it hasn't expired
export function computeStatus(notice, now = new Date()) {
  if (notice.isArchived) return 'archived';
  if (notice.isDraft) return 'draft';
  const publishAt = new Date(notice.publishAt);
  if (publishAt > now) return 'scheduled';
  if (notice.expiryAt && new Date(notice.expiryAt) <= now) return 'expired';
  return 'published';
}

export function withStatus(notice) {
  return notice && { ...notice, status: computeStatus(notice) };
}

// Validates and normalizes a create/update payload. `partial` allows PUT
// to only require the fields the caller actually sent (paired with the
// existing record by routes.js), matching the sanitize-then-merge pattern
// staffLeave/fees already use elsewhere in this codebase.
export function sanitizeNoticePayload(body, { partial = false } = {}) {
  body = body || {};
  const out = {};

  const need = (key, valid, message) => {
    if (body[key] === undefined) {
      if (!partial) throw badRequest(message);
      return;
    }
    if (!valid(body[key])) throw badRequest(message);
    out[key] = body[key];
  };

  need('title', (v) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 200, 'title is required (max 200 characters)');
  if (out.title) out.title = out.title.trim();

  need('category', (v) => CATEGORIES.includes(v), `category must be one of ${CATEGORIES.join(', ')}`);

  need('description', (v) => typeof v === 'string' && v.trim().length > 0, 'description is required');
  if (out.description) out.description = out.description.trim();

  need('audienceType', (v) => AUDIENCE_TYPES.includes(v), `audienceType must be one of ${AUDIENCE_TYPES.join(', ')}`);

  need('publishAt', isValidIsoDateTime, 'publishAt must be a valid date/time');

  if (body.expiryAt !== undefined && body.expiryAt !== null && body.expiryAt !== '') {
    if (!isValidIsoDateTime(body.expiryAt)) throw badRequest('expiryAt must be a valid date/time');
    out.expiryAt = body.expiryAt;
    if (out.publishAt && new Date(out.expiryAt) <= new Date(out.publishAt)) {
      throw badRequest('expiryAt must be after publishAt');
    }
  } else if (body.expiryAt === null || body.expiryAt === '') {
    out.expiryAt = null;
  }

  // Audience sub-fields are only meaningful for the matching audienceType;
  // anything not relevant to the chosen type is dropped rather than kept
  // around stale, so a notice can never carry a class name left over from
  // when it used to target "class" before being edited to "role".
  const audienceType = out.audienceType ?? body.audienceType;
  out.audienceRole = null;
  out.audienceClassName = null;
  out.audienceSection = null;
  out.audienceRecipientType = null;
  out.audienceRecipientId = null;

  if (audienceType === 'role') {
    if (!AUDIENCE_ROLES.includes(body.audienceRole)) throw badRequest(`audienceRole must be one of ${AUDIENCE_ROLES.join(', ')} when audienceType is "role"`);
    out.audienceRole = body.audienceRole;
  } else if (audienceType === 'class') {
    if (typeof body.audienceClassName !== 'string' || !body.audienceClassName.trim()) throw badRequest('audienceClassName is required when audienceType is "class"');
    out.audienceClassName = body.audienceClassName.trim();
    out.audienceSection = typeof body.audienceSection === 'string' && body.audienceSection.trim() ? body.audienceSection.trim() : null;
  } else if (audienceType === 'individual') {
    if (!RECIPIENT_TYPES.includes(body.audienceRecipientType)) throw badRequest(`audienceRecipientType must be one of ${RECIPIENT_TYPES.join(', ')} when audienceType is "individual"`);
    if (typeof body.audienceRecipientId !== 'string' || !body.audienceRecipientId.trim()) throw badRequest('audienceRecipientId is required when audienceType is "individual"');
    out.audienceRecipientType = body.audienceRecipientType;
    out.audienceRecipientId = body.audienceRecipientId.trim();
  } else if (audienceType && audienceType !== 'entire_school' && !partial) {
    throw badRequest(`audienceType must be one of ${AUDIENCE_TYPES.join(', ')}`);
  }
  // If this is a partial update and audienceType wasn't sent, leave the
  // audience-related keys out of `out` entirely so routes.js's merge
  // keeps whatever the existing record already had.
  if (partial && body.audienceType === undefined) {
    delete out.audienceRole;
    delete out.audienceClassName;
    delete out.audienceSection;
    delete out.audienceRecipientType;
    delete out.audienceRecipientId;
  }

  return out;
}

export function sanitizeAcknowledgementPayload(body) {
  body = body || {};
  const { recipientLabel, method = 'other', note = '' } = body;
  if (typeof recipientLabel !== 'string' || !recipientLabel.trim()) throw badRequest('recipientLabel is required');
  if (!ACK_METHODS.includes(method)) throw badRequest(`method must be one of ${ACK_METHODS.join(', ')}`);
  if (typeof note !== 'string') throw badRequest('note must be a string');
  return { recipientLabel: recipientLabel.trim(), method, note: note.trim() };
}
