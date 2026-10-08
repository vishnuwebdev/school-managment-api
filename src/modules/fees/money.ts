/**
 * Money arithmetic. Amounts are DECIMAL(14,2) strings at the edges (database and API) and BIGINT
 * minor units (paise/cents) inside: `"4000.50"` ↔ `400050n`. JavaScript floats never touch money.
 */

const DECIMAL = /^-?\d+(\.\d{1,2})?$/;
export const MONEY_INPUT = /^\d{1,12}(\.\d{1,2})?$/;

/** '1234.5' / '1234.50' / '1234' → 123450n. Throws on anything that is not a plain decimal. */
export function toMinor(value: string): bigint {
  if (!DECIMAL.test(value)) throw new Error(`Not a decimal amount: ${value}`);
  const neg = value.startsWith('-');
  const [whole, frac = ''] = (neg ? value.slice(1) : value).split('.');
  const minor = BigInt(whole!) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -minor : minor;
}

/** 123450n → '1234.50'. */
export function fromMinor(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Normalises a stored/received decimal to two places ('4000' → '4000.00'). */
export const normalizeMoney = (v: string): string => fromMinor(toMinor(v));

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/** Percentage string ('12.5') → hundredths of a percent (1250n). */
export function percentToBp(value: string): bigint {
  if (!DECIMAL.test(value)) throw new Error(`Not a decimal percentage: ${value}`);
  return toMinor(value); // same scale: two decimals
}

/** `minor × bp / 10000`, rounded half up (non-negative inputs). */
export function applyBp(minor: bigint, bp: bigint): bigint {
  return (minor * bp + 5000n) / 10_000n;
}

/** Sum of decimal strings, exactly. */
export const sumMoney = (values: string[]): string =>
  fromMinor(values.reduce((a, v) => a + toMinor(v), 0n));
