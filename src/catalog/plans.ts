import { FEATURES, type FeatureCode } from './features.js';

/**
 * Commercial plans (version 1). Prices are PLACEHOLDERS in minor units (paise)
 * — confirm real pricing before production. Plans change by adding a new plan
 * version, never by editing a version that subscriptions already reference.
 */
export interface PlanDef {
  code: string;
  name: string;
  description: string;
  currency: string;
  priceMonthlyMinor: number;
  priceAnnualMinor: number;
  features: FeatureCode[];
}

const BASE_STARTER: FeatureCode[] = [
  'students',
  'students.documents',
  'academics',
  'teachers',
  'attendance',
  'communication',
  'reports',
];
/**
 * A plan contains the features it lists plus every capability beneath them
 * (so adding a capability to the catalog never removes anything from a plan).
 */
function withCapabilities(base: FeatureCode[]): FeatureCode[] {
  const out = new Set<FeatureCode>(base);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of FEATURES as readonly { code: FeatureCode; parent?: string; kind?: string }[]) {
      if (
        f.kind === 'capability' &&
        f.parent &&
        out.has(f.parent as FeatureCode) &&
        !out.has(f.code)
      ) {
        out.add(f.code);
        grew = true;
      }
    }
  }
  return [...out];
}

const STARTER: FeatureCode[] = withCapabilities(BASE_STARTER);
const BASE_STANDARD: FeatureCode[] = [
  ...BASE_STARTER,
  'students.admissions',
  'examinations',
  'fees',
  'timetable',
  'leave',
  'parent_portal',
];
const STANDARD: FeatureCode[] = withCapabilities(BASE_STANDARD);
const PREMIUM: FeatureCode[] = withCapabilities([
  ...BASE_STANDARD,
  'attendance.subject',
  'examinations.online_results',
  'fees.online_payments',
  'library',
  'transport',
  'communication.sms',
  'integrations',
  'custom_roles',
]);

export const PLANS: PlanDef[] = [
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
    description: 'Everything, including library, transport and integrations.',
    currency: 'INR',
    priceMonthlyMinor: 999_900,
    priceAnnualMinor: 9_999_000,
    features: PREMIUM,
  },
];
