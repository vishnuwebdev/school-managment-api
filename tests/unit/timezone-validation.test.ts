import { describe, expect, it } from 'vitest';
import { SettingsBody, isValidTimeZone } from '../../src/modules/tenants/schemas.js';

describe('school time zone validation', () => {
  it('accepts Asia/Kolkata and its older alias', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Asia/Calcutta')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects names that are not time zones', () => {
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('India')).toBe(false);
  });

  it('lets the settings form save Asia/Kolkata', () => {
    expect(SettingsBody.safeParse({ version: 1, timezone: 'Asia/Kolkata' }).success).toBe(true);
    expect(SettingsBody.safeParse({ version: 1, timezone: 'Nowhere/City' }).success).toBe(false);
  });
});
