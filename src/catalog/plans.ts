import type { FeatureCode } from './features.js';

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

const STARTER: FeatureCode[] = [
  'students',
  'students.documents',
  'academics',
  'teachers',
  'attendance',
  'communication',
  'reports',
];
const STANDARD: FeatureCode[] = [
  ...STARTER,
  'students.admissions',
  'examinations',
  'fees',
  'timetable',
  'leave',
  'parent_portal',
];
const PREMIUM: FeatureCode[] = [
  ...STANDARD,
  'attendance.subject',
  'examinations.online_results',
  'fees.online_payments',
  'library',
  'transport',
  'communication.sms',
  'integrations',
];

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
