import type { tenantProfiles, tenantSettings, tenants } from '../../db/schema/index.js';

export function presentTenant(t: typeof tenants.$inferSelect) {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    short_name: t.shortName,
    school_type: t.schoolType,
    status: t.status,
    contact_email: t.contactEmail,
    contact_phone: t.contactPhone,
    address: {
      line1: t.addressLine1,
      line2: t.addressLine2,
      city: t.city,
      state: t.state,
      postal_code: t.postalCode,
      country: t.country,
    },
    version: t.version,
    activated_at: t.activatedAt?.toISOString() ?? null,
    suspended_at: t.suspendedAt?.toISOString() ?? null,
    archived_at: t.archivedAt?.toISOString() ?? null,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  };
}

export function presentSettings(s: typeof tenantSettings.$inferSelect) {
  return {
    timezone: s.timezone,
    locale: s.locale,
    currency: s.currency,
    date_format: s.dateFormat,
    week_starts_on: s.weekStartsOn,
    working_days: s.workingDays,
    academic_year_start_month: s.academicYearStartMonth,
    brand_primary_color: s.brandPrimaryColor,
    brand_secondary_color: s.brandSecondaryColor,
    brand_accent_color: s.brandAccentColor,
    logo_file_id: s.logoFileId,
    banner_file_id: s.bannerFileId,
    document_header_file_id: s.documentHeaderFileId,
    version: s.version,
    updated_at: s.updatedAt.toISOString(),
  };
}

const emptyToNull = <T>(v: T | null | undefined) => v ?? null;

export function presentProfileExtras(p: typeof tenantProfiles.$inferSelect | undefined) {
  return {
    affiliation_board: emptyToNull(p?.affiliationBoard),
    affiliation_number: emptyToNull(p?.affiliationNumber),
    school_code: emptyToNull(p?.schoolCode),
    established_year: emptyToNull(p?.establishedYear),
    medium_of_instruction: emptyToNull(p?.mediumOfInstruction),
    motto: emptyToNull(p?.motto),
    about: emptyToNull(p?.about),
    secondary_phone: emptyToNull(p?.secondaryPhone),
    landline: emptyToNull(p?.landline),
    reception_phone: emptyToNull(p?.receptionPhone),
    alternate_email: emptyToNull(p?.alternateEmail),
    contact_person_name: emptyToNull(p?.contactPersonName),
    contact_person_role: emptyToNull(p?.contactPersonRole),
    document_footer: emptyToNull(p?.documentFooter),
  };
}
