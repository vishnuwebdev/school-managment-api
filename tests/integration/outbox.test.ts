import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvents } from '../../src/db/schema/index.js';
import { processEvent, relayOutbox } from '../../src/events/processor.js';
import { createHarness, type Harness } from '../helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.drainOutbox();
});
afterAll(() => h.close());

describe('outbox & event processing', () => {
  it('handlers are idempotent under redelivery', async () => {
    const S = await h.provisionSchool();
    const email = `dup-${Date.now()}@school.test`;
    const teacher = await h.roleId(S.admin.api, 'TEACHER');
    await S.admin.api.post('/members/invitations', {
      email,
      first_name: 'Dup',
      roles: [{ role_id: teacher }],
    });
    // This school's own pending invitation event (not "the oldest 100 in the shared test database",
    // which stops containing it once the suite has created enough invitations).
    const [event] = await h.deps.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, S.tenantId),
          eq(outboxEvents.eventType, 'invitation.created'),
          eq(outboxEvents.status, 'PENDING'),
        ),
      )
      .orderBy(outboxEvents.occurredAt)
      .limit(1);
    expect(event).toBeTruthy();

    await processEvent(h.deps, event!.id);
    await processEvent(h.deps, event!.id); // at-least-once delivery
    await h.drainOutbox();
    expect(h.mailer.sent.filter((m) => m.to === email)).toHaveLength(1);
  });

  it('retries failed publishes with backoff and keeps the error', async () => {
    const S = await h.provisionSchool();
    await h.drainOutbox();
    await S.admin.api.post('/members/invitations', {
      email: `retry-${Date.now()}@school.test`,
      first_name: 'R',
      roles: [{ role_id: await h.roleId(S.admin.api, 'TEACHER') }],
    });
    const n = await relayOutbox(h.deps, async () => {
      throw new Error('queue down');
    });
    expect(n).toBeGreaterThan(0);
    const failed = (
      await h.deps.db.select().from(outboxEvents).where(eq(outboxEvents.lastError, 'queue down'))
    )[0];
    expect(failed!.status).toBe('PENDING');
    expect(failed!.retryCount).toBe(1);
    expect(failed!.availableAt.getTime()).toBeGreaterThan(Date.now());
  });
});
