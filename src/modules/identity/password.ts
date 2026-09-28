import argon2 from 'argon2';
import { z } from 'zod';

/** Password policy shared by every endpoint that sets a password. */
export const PasswordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password must contain letters and numbers');

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// Used to keep login timing constant when the email does not exist.
let dummyHash: Promise<string> | null = null;
export function dummyVerify(plain: string): Promise<boolean> {
  dummyHash ??= hashPassword('dummy-password-for-timing-1');
  return dummyHash.then((h) => verifyPassword(h, plain)).then(() => false);
}
