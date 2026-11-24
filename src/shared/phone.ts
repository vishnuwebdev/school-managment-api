/**
 * Mobile numbers used to sign in (parent app). Stored as digits only with the country code
 * (`919876543210`), so "+91 98765 43210", "098765 43210" and "9876543210" all name the same
 * login once the school's country is known.
 */

const DIAL_CODES: Readonly<Record<string, string>> = {
  IN: '91',
  ZA: '27',
  US: '1',
  CA: '1',
  GB: '44',
  AE: '971',
  SA: '966',
  QA: '974',
  KE: '254',
  NG: '234',
  NP: '977',
  LK: '94',
  BD: '880',
  PK: '92',
  SG: '65',
  MY: '60',
  AU: '61',
  NZ: '64',
};

export const DEFAULT_COUNTRY = 'IN';

/** Shortest national number we accept (most countries use 9–10 digits). */
const MIN_NATIONAL = 7;

export function dialCodeOf(country: string | null | undefined): string {
  return DIAL_CODES[(country ?? DEFAULT_COUNTRY).toUpperCase()] ?? DIAL_CODES[DEFAULT_COUNTRY]!;
}

/** What a person typed, split into "has its country code" or "national number only". */
export type PhoneInput = { full: string } | { national: string };

/** Parse typed input. Returns null when it cannot be a mobile number. */
export function parsePhone(raw: string): PhoneInput | null {
  const trimmed = raw.trim();
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('00')) digits = digits.slice(2);
  if (digits.length < MIN_NATIONAL || digits.length > 15) return null;
  if (international) return { full: digits };
  // A leading 0 is the national trunk prefix ("082 123 4567", "098765 43210").
  if (digits.startsWith('0')) return { national: digits.replace(/^0+/, '') };
  // Longer than a national number: assume the country code is already there.
  if (digits.length > 10) return { full: digits };
  return { national: digits };
}

/** The stored form for a school in [country]; null when the input is not a mobile number. */
export function toLoginPhone(raw: string, country: string | null | undefined): string | null {
  const p = parsePhone(raw);
  if (!p) return null;
  if ('full' in p) return p.full;
  if (p.national.length < MIN_NATIONAL) return null;
  return `${dialCodeOf(country)}${p.national}`;
}
