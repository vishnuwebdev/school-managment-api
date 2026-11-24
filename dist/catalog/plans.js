import { FEATURES } from './features.js';
const BASE_STARTER = [
    'students',
    'students.documents',
    'academics',
    'teachers',
    'teachers.mobile_app',
    'attendance',
    'communication',
    'reports',
];
/**
 * A plan contains the features it lists plus every capability beneath them
 * (so adding a capability to the catalog never removes anything from a plan).
 */
function withCapabilities(base) {
    const out = new Set(base);
    let grew = true;
    while (grew) {
        grew = false;
        for (const f of FEATURES) {
            if (f.kind === 'capability' &&
                f.parent &&
                out.has(f.parent) &&
                !out.has(f.code)) {
                out.add(f.code);
                grew = true;
            }
        }
    }
    return [...out];
}
const STARTER = withCapabilities(BASE_STARTER);
const BASE_STANDARD = [
    ...BASE_STARTER,
    'students.admissions',
    'examinations',
    'fees',
    'timetable',
    'parent_portal',
];
const STANDARD = withCapabilities(BASE_STANDARD);
const PREMIUM = withCapabilities([
    ...BASE_STANDARD,
    'attendance.subject',
    'custom_roles',
]);
export const PLANS = [
    {
        code: 'STARTER',
        name: 'Starter',
        description: 'Core school administration.',
        currency: 'INR',
        priceMonthlyMinor: 299_900,
        priceAnnualMinor: 2_999_000,
        features: STARTER,
    },
    {
        code: 'STANDARD',
        name: 'Standard',
        description: 'Adds exams, fees, timetable and the parent portal.',
        currency: 'INR',
        priceMonthlyMinor: 599_900,
        priceAnnualMinor: 5_999_000,
        features: STANDARD,
    },
    {
        code: 'PREMIUM',
        name: 'Premium',
        description: 'Adds custom roles and subject/period attendance.',
        currency: 'INR',
        priceMonthlyMinor: 999_900,
        priceAnnualMinor: 9_999_000,
        features: PREMIUM,
    },
];
