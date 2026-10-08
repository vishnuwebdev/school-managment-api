import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registrationTypesFor } from '../../src/catalog/registration-types.js';
import { LocalDiskStorage } from '../../src/infrastructure/storage/storage.js';
import { decryptSecret, encryptSecret, fingerprint } from '../../src/shared/crypto.js';

const KEY = 'k'.repeat(40);

describe('field encryption', () => {
  it('round-trips and never repeats a ciphertext', () => {
    const a = encryptSecret('123456789012', KEY);
    const b = encryptSecret('123456789012', KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain('123456789012');
    expect(decryptSecret(a, KEY)).toBe('123456789012');
  });

  it('refuses a wrong key and tampered data', () => {
    const a = encryptSecret('secret', KEY);
    expect(() => decryptSecret(a, 'z'.repeat(40))).toThrow();
    const parts = a.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), KEY)).toThrow();
  });

  it('fingerprints are stable for the same input and differ with the key', () => {
    expect(fingerprint('a', KEY)).toBe(fingerprint('a', KEY));
    expect(fingerprint('a', KEY)).not.toBe(fingerprint('a', 'z'.repeat(40)));
  });
});

describe('local disk storage', () => {
  it('stores, reads and deletes, and refuses paths outside its root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sms-store-'));
    const s = new LocalDiskStorage(dir);
    await s.put('t1/a.png', Buffer.from('abc'));
    expect((await s.get('t1/a.png'))!.toString()).toBe('abc');
    expect(await readFile(join(dir, 't1/a.png'), 'utf8')).toBe('abc');
    await s.delete('t1/a.png');
    expect(await s.get('t1/a.png')).toBeNull();
    await expect(s.put('../escape.txt', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(s.get('../../etc/passwd')).rejects.toThrow('Invalid storage key');
  });
});

describe('India registration templates', () => {
  const t = (code: string) => registrationTypesFor('IN').find((x) => x.code === code)!;
  it('accepts valid and rejects invalid identifiers', () => {
    expect(t('PAN').pattern!.test('AAAPL1234C')).toBe(true);
    expect(t('PAN').pattern!.test('AAAPL12345')).toBe(false);
    expect(t('TAN').pattern!.test('DELA12345B')).toBe(true);
    expect(t('GSTIN').pattern!.test('07AAAPL1234C1Z5')).toBe(true);
    expect(t('GSTIN').pattern!.test('07AAAPL1234C1X5')).toBe(false);
    expect(t('UDISE').pattern!.test('09010101001')).toBe(true);
    expect(t('UDISE').pattern!.test('0901010100')).toBe(false);
  });
  it('falls back to India for unknown countries', () => {
    expect(registrationTypesFor('ZZ').length).toBeGreaterThan(0);
    expect(registrationTypesFor(null).map((x) => x.code)).toContain('GSTIN');
  });
});
