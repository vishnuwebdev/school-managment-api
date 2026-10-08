import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEvents } from '../../src/db/schema/index.js';
import { diffAssignments } from '../../src/modules/members/members.service.js';
import { createHarness, type Harness } from '../helpers.js';

/**
 * D56 — user and role administration publishes outbox events, committed with the
 * change, so notifications ("role changed", "access suspended") can be built on them.
 */
let h: Harness;
type School = Awaited<ReturnType<Harness['provisionSchool']>>;
let S: School;

beforeAll(async () => {
  h = await createHarness();
  S = await h.provisionSchool();
});
afterAll(() => h.close());

async function events(aggregateId: string) {
  return h.deps.db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.tenantId, S.tenantId), eq(outboxEvents.aggregateId, aggregateId)))
    .orderBy(asc(outboxEvents.occurredAt), asc(outboxEvents.id));
}
const types = async (id: string) => (await events(id)).map((e) => e.eventType);

describe('membership events', () => {
  it('suspend and reactivate publish membership.suspended / membership.reactivated (ids only)', async () => {
    const m = await h.addMember(S.admin.api, [{ role_id: await h.roleId(S.admin.api, 'TEACHER') }]);
    const userId = (await S.admin.api.get(`/members/${m.membershipId}`)).body.data.user.id;
    await S.admin.api.post(`/members/${m.membershipId}/suspend`, { reason: 'Long leave' });
    await S.admin.api.post(`/members/${m.membershipId}/reactivate`, { reason: 'Back at school' });
    const list = await events(m.membershipId);
    const suspended = list.find((e) => e.eventType === 'membership.suspended')!;
    expect(suspended.payload).toEqual({ membership_id: m.membershipId, user_id: userId });
    expect(suspended.actorUserId).toBeTruthy();
    expect(list.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['membership.suspended', 'membership.reactivated']),
    );
  });

  it('a refused suspension publishes nothing', async () => {
    const me = await S.admin.api.get('/auth/me');
    const id = me.body.data.membership.id;
    const before = await types(id);
    expect((await S.admin.api.post(`/members/${id}/suspend`, { reason: 'Self' })).status).toBe(422);
    expect(await types(id)).toEqual(before);
  });

  it('changing roles publishes membership.roles_changed with what was added and removed', async () => {
    const teacher = await h.roleId(S.admin.api, 'TEACHER');
    const accountant = await h.roleId(S.admin.api, 'ACCOUNTANT');
    const m = await h.addMember(S.admin.api, [{ role_id: teacher }]);
    await S.admin.api.put(`/members/${m.membershipId}/roles`, {
      roles: [{ role_id: teacher, scope_type: 'ASSIGNED_SECTION' }, { role_id: accountant }],
    });
    const changed = (await events(m.membershipId)).filter(
      (e) => e.eventType === 'membership.roles_changed',
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({
      membership_id: m.membershipId,
      added: expect.arrayContaining([
        { role_id: teacher, scope_type: 'ASSIGNED_SECTION', scope_ref: null },
        { role_id: accountant, scope_type: 'ALL_TENANT', scope_ref: null },
      ]),
      removed: [{ role_id: teacher, scope_type: 'ALL_TENANT', scope_ref: null }],
    });
    // Saving the same roles again changes nothing, so no event.
    await S.admin.api.put(`/members/${m.membershipId}/roles`, {
      roles: [{ role_id: accountant }, { role_id: teacher, scope_type: 'ASSIGNED_SECTION' }],
    });
    expect(
      (await types(m.membershipId)).filter((t) => t === 'membership.roles_changed'),
    ).toHaveLength(1);
  });
});

describe('role events', () => {
  it('creating and archiving a custom role publish role.created / role.archived', async () => {
    const created = await S.admin.api.post('/roles', {
      name: `Event Role ${Date.now()}`,
      permissions: ['students.read', 'attendance.read'],
    });
    const id = created.body.data.id as string;
    await h.addMember(S.admin.api, [{ role_id: id }]);
    await S.admin.api.post(`/roles/${id}/archive`, { reason: 'No longer used' });
    const list = await events(id);
    expect(list.map((e) => e.eventType)).toEqual(['role.created', 'role.archived']);
    expect(list[0]!.payload).toEqual({
      role_id: id,
      permissions: ['attendance.read', 'students.read'],
    });
    expect(list[1]!.payload).toEqual({
      role_id: id,
      member_count: 1,
      permissions: ['attendance.read', 'students.read'],
    });
  });
});

describe('diffAssignments', () => {
  it('ignores order of roles and ids; a scope change is a removal plus an addition', () => {
    const a = {
      role_id: 'r',
      scope_type: 'ASSIGNED_SECTION',
      scope_ref: { section_ids: ['x', 'y'] },
    };
    const b = {
      role_id: 'r',
      scope_type: 'ASSIGNED_SECTION',
      scope_ref: { section_ids: ['y', 'x'] },
    };
    expect(diffAssignments([a], [b])).toEqual({ added: [], removed: [] });
    const wide = { role_id: 'r', scope_type: 'ALL_TENANT', scope_ref: null };
    expect(diffAssignments([a], [wide])).toEqual({ added: [wide], removed: [a] });
  });
});
