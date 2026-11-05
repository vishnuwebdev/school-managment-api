import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Deps } from '../../container.js';
import type { Executor } from '../../db/client.js';
import { appPins } from '../../db/schema/index.js';
import { recordAudit } from '../../platform/audit.js';
import type { Actor } from '../../platform/context.js';
import { randomToken, sha256 } from '../../shared/crypto.js';
import { AuthenticationError, AuthorizationError } from '../../shared/errors.js';
import type { DeviceInfo } from './auth.service.js';
import { hashPassword, verifyPassword } from './password.js';

/** Wrong PINs allowed before PIN sign-in locks (unlocked by setting a new PIN). */
export const PIN_MAX_ATTEMPTS = 5;

/** Same rules as the teacher app: 4 digits, no repeated or sequential digits. */
export const PinSchema = z
  .string()
  .regex(/^\d{4}$/, 'The PIN must be 4 digits')
  .refine(
    (p) => !/^(\d)\1{3}$/.test(p) && !'0123456789'.includes(p) && !'9876543210'.includes(p),
    'Avoid repeated or sequential digits like 1111 or 1234',
  );

export type PinStatus = 'NONE' | 'SET' | 'LOCKED';

export interface PinState {
  status: PinStatus;
  set_at: string | null;
  locked_at: string | null;
  last_used_at: string | null;
  device_name: string | null;
}

const NO_PIN: PinState = {
  status: 'NONE',
  set_at: null,
  locked_at: null,
  last_used_at: null,
  device_name: null,
};

/**
 * Mobile-app sign-in PIN, one per school login (membership).
 *
 * Setting a PIN returns a random device token that only the app keeps; PIN
 * sign-in needs that token and the PIN. A school admin can reset the PIN (the
 * row is deleted), after which the teacher signs in with the password and
 * chooses a new one. The admin never sees or sets the PIN.
 */
export class AppPinService {
  constructor(private readonly deps: Deps) {}

  async status(
    tenantId: string,
    membershipId: string,
    ex: Executor = this.deps.db,
  ): Promise<PinState> {
    const [row] = await ex
      .select()
      .from(appPins)
      .where(and(eq(appPins.tenantId, tenantId), eq(appPins.membershipId, membershipId)));
    if (!row) return NO_PIN;
    return {
      status: row.lockedAt ? 'LOCKED' : 'SET',
      set_at: row.createdAt.toISOString(),
      locked_at: row.lockedAt?.toISOString() ?? null,
      last_used_at: row.lastUsedAt?.toISOString() ?? null,
      device_name: row.deviceName,
    };
  }

  /** Set or replace the signed-in user's PIN. Any previous PIN and device token stop working. */
  async set(
    input: {
      tenantId: string;
      membershipId: string;
      userId: string;
      pin: string;
      device: DeviceInfo;
    },
    actor: Actor,
  ) {
    const pinHash = await hashPassword(input.pin);
    const token = randomToken();
    await this.deps.db.transaction(async (tx) => {
      await deletePin(tx, input.tenantId, input.membershipId);
      await tx.insert(appPins).values({
        tenantId: input.tenantId,
        membershipId: input.membershipId,
        userId: input.userId,
        pinHash,
        deviceTokenHash: sha256(token),
        deviceName: input.device.deviceName ?? null,
        deviceType: input.device.deviceType ?? null,
      });
      await recordAudit(tx, actor, {
        tenantId: input.tenantId,
        action: 'APP_PIN_SET',
        entityType: 'membership',
        entityId: input.membershipId,
        after: { device_name: input.device.deviceName ?? null },
      });
    });
    return { pin_token: token, ...(await this.status(input.tenantId, input.membershipId)) };
  }

  /** The user turns PIN sign-in off. Returns whether a PIN existed. */
  async remove(tenantId: string, membershipId: string, actor: Actor) {
    return this.deps.db.transaction(async (tx) => {
      const removed = await deletePin(tx, tenantId, membershipId);
      if (removed)
        await recordAudit(tx, actor, {
          tenantId,
          action: 'APP_PIN_REMOVED',
          entityType: 'membership',
          entityId: membershipId,
        });
      return removed;
    });
  }

  /** An admin clears someone's PIN (forgotten or locked). Returns whether a PIN existed. */
  async reset(
    tx: Executor,
    tenantId: string,
    membershipId: string,
    actor: Actor,
    reason: string,
  ): Promise<boolean> {
    const before = await this.status(tenantId, membershipId, tx);
    const removed = await deletePin(tx, tenantId, membershipId);
    if (removed)
      await recordAudit(tx, actor, {
        tenantId,
        action: 'APP_PIN_RESET',
        entityType: 'membership',
        entityId: membershipId,
        before: { status: before.status, locked_at: before.locked_at },
        after: { status: 'NONE' },
        reason,
      });
    return removed;
  }

  /**
   * Check a PIN sign-in. Wrong PINs count up; at PIN_MAX_ATTEMPTS the PIN locks
   * until a new one is set. Returns the login to start a session for.
   */
  async verify(pinToken: string, pin: string) {
    const [row] = await this.deps.db
      .select()
      .from(appPins)
      .where(eq(appPins.deviceTokenHash, sha256(pinToken)));
    if (!row)
      throw new AuthenticationError(
        'PIN_NOT_SET',
        'PIN sign-in is not set up on this device. Sign in with your password.',
      );
    if (row.lockedAt) throw pinLocked();

    if (!(await verifyPassword(row.pinHash, pin))) {
      // Atomic increment, so parallel attempts cannot get past the limit.
      await this.deps.db
        .update(appPins)
        .set({ failedAttempts: sql`${appPins.failedAttempts} + 1` })
        .where(and(eq(appPins.id, row.id), isNull(appPins.lockedAt)));
      const [after] = await this.deps.db.select().from(appPins).where(eq(appPins.id, row.id));
      if (!after || after.lockedAt) throw pinLocked();
      if (after.failedAttempts >= PIN_MAX_ATTEMPTS) {
        await this.deps.db
          .update(appPins)
          .set({ lockedAt: this.deps.clock.now() })
          .where(and(eq(appPins.id, row.id), isNull(appPins.lockedAt)));
        throw pinLocked();
      }
      throw new AuthenticationError('INVALID_PIN', 'The PIN is incorrect', {
        attempts_left: Math.max(0, PIN_MAX_ATTEMPTS - after.failedAttempts),
      });
    }
    return {
      pinId: row.id,
      tenantId: row.tenantId,
      membershipId: row.membershipId,
      userId: row.userId,
      device: { deviceName: row.deviceName, deviceType: row.deviceType },
    };
  }

  /**
   * Signed-in check of my current PIN (teacher app: Change PIN). Same counting
   * and locking as PIN sign-in; the PIN must belong to the signed-in login.
   */
  async verifyMine(pinToken: string, pin: string, membershipId: string) {
    const v = await this.verify(pinToken, pin);
    if (v.membershipId !== membershipId)
      throw new AuthenticationError(
        'PIN_NOT_SET',
        'PIN sign-in is not set up on this device. Sign in with your password.',
      );
    await this.markUsed(this.deps.db, v.pinId);
  }

  /** After a successful PIN sign-in. */
  async markUsed(tx: Executor, pinId: string) {
    await tx
      .update(appPins)
      .set({ failedAttempts: 0, lastUsedAt: this.deps.clock.now() })
      .where(eq(appPins.id, pinId));
  }
}

/** Delete the PIN of a login, in the caller's transaction. Returns whether one existed. */
export async function deletePin(tx: Executor, tenantId: string, membershipId: string) {
  const [res] = await tx
    .delete(appPins)
    .where(and(eq(appPins.tenantId, tenantId), eq(appPins.membershipId, membershipId)));
  return res.affectedRows > 0;
}

const pinLocked = () =>
  new AuthorizationError(
    'PIN_LOCKED',
    'Too many wrong PINs. Sign in with your password and choose a new PIN, or ask the school office to reset it.',
  );
