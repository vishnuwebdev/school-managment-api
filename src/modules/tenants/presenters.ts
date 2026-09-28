import type { tenantSettings, tenants } from '../../db/schema/index.js';

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
    logo_file_id: s.logoFileId,
    version: s.version,
    updated_at: s.updatedAt.toISOString(),
  };
}
