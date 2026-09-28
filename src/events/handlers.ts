import { and, eq } from 'drizzle-orm';
import type { Deps } from '../container.js';
import {
  invitations,
  memberships,
  passwordResetTokens,
  tenants,
  users,
  type outboxEvents,
} from '../db/schema/index.js';
import { randomToken, sha256 } from '../shared/crypto.js';

export type OutboxRow = typeof outboxEvents.$inferSelect;

export interface EventHandler {
  /** Stable name — part of the idempotency key (event_id, handler). */
  name: string;
  handle(event: OutboxRow, deps: Deps): Promise<void>;
}

/**
 * Invitation email. The raw token exists only in this function and the email:
 * we send first, then store the hash with a conditional update. A crash in
 * between means a retry sends a fresh link — never a leaked or reusable one.
 */
const sendInvitation: EventHandler = {
  name: 'email.invitation',
  async handle(event, deps) {
    const invitationId = String(event.payload.invitation_id);
    const [row] = await deps.db
      .select({
        inv: invitations,
        firstName: users.firstName,
        tenantName: tenants.name,
        kind: memberships.kind,
      })
      .from(invitations)
      .innerJoin(memberships, eq(memberships.id, invitations.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(tenants, eq(tenants.id, invitations.tenantId))
      .where(eq(invitations.id, invitationId));
    if (!row || row.inv.status !== 'PENDING') return; // superseded, revoked or already sent

    const token = randomToken();
    const link = `${deps.env.APP_BASE_URL}/accept-invitation?token=${encodeURIComponent(token)}`;
    const where = row.tenantName ? row.tenantName : 'the school management platform';
    await deps.mailer.send({
      to: row.inv.email,
      subject: `You're invited to ${where}`,
      template: 'invitation',
      data: { token, link, first_name: row.firstName, tenant_name: row.tenantName, kind: row.kind },
      text: `Hello ${row.firstName},\n\nYou have been invited to ${where}.\nAccept the invitation: ${link}\n\nThis link expires on ${row.inv.expiresAt.toUTCString()}.`,
    });
    await deps.db
      .update(invitations)
      .set({ tokenHash: sha256(token), status: 'SENT', sentAt: deps.clock.now() })
      .where(and(eq(invitations.id, invitationId), eq(invitations.status, 'PENDING')));
  },
};

const sendPasswordReset: EventHandler = {
  name: 'email.password_reset',
  async handle(event, deps) {
    const resetId = String(event.payload.reset_id);
    const [row] = await deps.db
      .select({ reset: passwordResetTokens, email: users.email, firstName: users.firstName })
      .from(passwordResetTokens)
      .innerJoin(users, eq(users.id, passwordResetTokens.userId))
      .where(eq(passwordResetTokens.id, resetId));
    if (!row || row.reset.status !== 'PENDING' || row.reset.expiresAt <= deps.clock.now()) return;

    const token = randomToken();
    const link = `${deps.env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await deps.mailer.send({
      to: row.email,
      subject: 'Reset your password',
      template: 'password_reset',
      data: { token, link, first_name: row.firstName },
      text: `Hello ${row.firstName},\n\nReset your password: ${link}\n\nIf you did not ask for this, ignore this email.`,
    });
    await deps.db
      .update(passwordResetTokens)
      .set({ tokenHash: sha256(token), status: 'SENT', sentAt: deps.clock.now() })
      .where(and(eq(passwordResetTokens.id, resetId), eq(passwordResetTokens.status, 'PENDING')));
  },
};

/** event_type → handlers. Events without handlers are simply marked processed. */
export const HANDLERS: Record<string, EventHandler[]> = {
  'invitation.created': [sendInvitation],
  'password_reset.requested': [sendPasswordReset],
};
