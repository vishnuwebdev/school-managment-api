import { and, eq, ne } from 'drizzle-orm';
import { tenants, users } from '../../db/schema/index.js';
import { ConflictError, ValidationError } from '../../shared/errors.js';
import { toLoginPhone } from '../../shared/phone.js';
/**
 * Mobile numbers people sign in with (any login: staff, admins, parents). Stored digits-only with
 * the country code; a number names exactly one account on the platform.
 */
/** The school's country (decides the default dial code); India when unknown or platform-level. */
export async function countryOf(ex, tenantId) {
    if (!tenantId)
        return null;
    const [t] = await ex.select({ c: tenants.country }).from(tenants).where(eq(tenants.id, tenantId));
    return t?.c ?? null;
}
/** Normalise a typed mobile number for [tenantId]'s country, or fail with a field error. */
export async function normalizeLoginPhone(ex, raw, tenantId, field = 'mobile') {
    const phone = toLoginPhone(raw, await countryOf(ex, tenantId));
    if (!phone)
        throw new ValidationError('The request is invalid', {
            location: 'body',
            issues: [{ path: field, message: 'This is not a valid mobile number' }],
        });
    return phone;
}
/** Fails when another account already signs in with this number. */
export async function assertLoginPhoneFree(ex, phone, userId, field = 'mobile') {
    const [other] = await ex
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.loginPhone, phone), userId ? ne(users.id, userId) : undefined));
    if (other)
        throw new ConflictError('DUPLICATE_RESOURCE', 'This mobile number already signs in to another account', { field });
}
/** Shown as "+919876543210" in API responses. */
export const presentLoginPhone = (stored) => stored ? `+${stored}` : null;
