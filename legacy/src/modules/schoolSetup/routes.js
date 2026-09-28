import { Router } from 'express';
import { authenticate, tenantScope, permit } from '../../core/middleware.js';
import { asyncRoute, badRequest } from '../../core/errors.js';
import { db } from '../../db/index.js';

// RBAC rewrite (Phase 1 pilot): permissions here use the new
// feature:page:action model ('school-setup:profile:read'/'update')
// instead of the old flat 'school.settings.view'/'update' -- see
// core/permissionsV2.js. The old keys still resolve via permit()'s
// compatibility map, so a role stored with the old keys keeps working.
//
// School Setup > School Profile (7 sub-tabs) + Academic Settings >
// Promotion Settings, all stored as named sections on one per-tenant
// settings row (db.schoolProfile.get/updateSection) rather than as
// separate tables -- every one of these is "a form with a Save Changes
// button", not a list, so there's nothing to paginate or search. (Other
// Settings/preferences moved to the Settings module -- see
// modules/settings/routes.js.)
export const schoolSetupRouter = Router();

const PROFILE_SECTIONS = {
  basicInfo: {
    required: ['schoolName'],
    fields: ['schoolName', 'shortName', 'schoolType', 'affiliationBoard', 'affiliationNumber', 'schoolCode', 'establishedYear', 'mediumOfInstruction', 'motto', 'about'],
  },
  contact: {
    required: [],
    fields: ['primaryPhone', 'secondaryPhone', 'email', 'alternateEmail', 'landline', 'receptionPhone', 'fax', 'contactPersonName', 'designation'],
  },
  address: {
    required: ['addressLine1', 'city', 'state', 'pinCode', 'country'],
    fields: ['addressLine1', 'addressLine2', 'city', 'state', 'pinCode', 'country'],
  },
  branding: {
    required: [],
    fields: ['logoUrl', 'bannerUrl', 'primaryColor', 'secondaryColor', 'accentColor'],
  },
  bank: {
    required: [],
    fields: ['accountHolderName', 'bankName', 'accountNumber', 'ifscCode', 'branchName', 'accountType'],
  },
  registration: {
    required: [],
    fields: ['registrationNumber', 'registrationDate', 'trustSocietyName', 'trustRegistrationNumber', 'panNumber', 'tanNumber', 'gstNumber', 'udiseCode'],
  },
  social: {
    required: [],
    fields: ['website', 'facebook', 'instagram', 'youtube', 'twitter', 'linkedin'],
  },
  promotion: {
    required: [],
    fields: ['autoPromotion', 'requireApproval', 'allowExamChange', 'retainFailedStudents'],
    booleans: ['autoPromotion', 'requireApproval', 'allowExamChange', 'retainFailedStudents'],
  },
  // 'preferences' used to live here as "Other Settings" -- it has moved
  // to the Settings module (edusphere-settings-module-plan-2026-09-23.md,
  // GET/PUT /api/settings/regional), which owns its own validation and
  // permission (settings:regional:*) instead of school-setup:profile:*,
  // and dropped the 3 dead delivery-medium toggles that used to sit here.
  // The underlying storage (db.schoolProfile's 'preferences' section) is
  // unchanged, so existing saved values still carry over.
};

function sanitizeSection(section, body) {
  const spec = PROFILE_SECTIONS[section];
  if (!spec) throw badRequest(`Unknown profile section "${section}"`);
  for (const key of spec.required) {
    if (!body?.[key] || typeof body[key] !== 'string') throw badRequest(`${key} is required`);
  }
  const clean = {};
  for (const key of spec.fields) {
    if (body?.[key] === undefined) continue;
    if (spec.booleans?.includes(key)) {
      clean[key] = Boolean(body[key]);
    } else {
      if (typeof body[key] !== 'string') throw badRequest(`${key} must be a string`);
      clean[key] = body[key].trim();
    }
  }
  return clean;
}

// Whole profile (all sections at once) -- used by the School Setup
// overview screen and anywhere that wants everything in one call.
schoolSetupRouter.get('/profile', authenticate, tenantScope, permit('school-setup:profile:read'), asyncRoute(async (req, res) => {
  res.json({ data: await db.schoolProfile.get(req.tenantId) });
}));

// One section at a time -- matches the design's per-tab "Save Changes"
// button (Basic Information, Contact Details, Address, ... each save
// independently rather than one giant form).
schoolSetupRouter.put('/profile/:section', authenticate, tenantScope, permit('school-setup:profile:update'), asyncRoute(async (req, res) => {
  const { section } = req.params;
  const clean = sanitizeSection(section, req.body || {});
  const profile = await db.schoolProfile.updateSection(req.tenantId, section, clean);
  await db.audit.record({ event: 'schoolProfile.updated', actorId: req.auth.sub, target: section, tenantId: req.tenantId });
  res.json({ data: profile });
}));

export const PROFILE_SECTION_KEYS = Object.keys(PROFILE_SECTIONS);
