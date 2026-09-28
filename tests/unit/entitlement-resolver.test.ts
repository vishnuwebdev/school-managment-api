import { describe, expect, it } from 'vitest';
import {
  dependentsOf,
  resolveEntitlements,
  type FeatureNode,
} from '../../src/modules/entitlements/entitlement-resolver.js';
import {
  effectiveSubscription,
  type SubscriptionLike,
} from '../../src/modules/entitlements/subscription-state.js';
import { canTransition } from '../../src/modules/tenants/lifecycle.js';
import { expandPermissionPatterns } from '../../src/catalog/permissions.js';
import { SYSTEM_ROLES, resolveSystemRolePermissions } from '../../src/catalog/roles.js';

const day = 86_400_000;
const now = new Date('2026-06-15T00:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * day);
const ahead = (d: number) => new Date(now.getTime() + d * day);

const sub = (over: Partial<SubscriptionLike>): SubscriptionLike => ({
  id: 'sub-1',
  status: 'ACTIVE',
  startsAt: ago(10),
  trialEndsAt: null,
  currentPeriodEnd: ahead(20),
  cancelledAt: null,
  endedAt: null,
  ...over,
});

describe('effectiveSubscription', () => {
  it.each([
    ['active in period', sub({}), 'FULL', 'ACTIVE'],
    ['trial running', sub({ status: 'TRIAL', trialEndsAt: ahead(3) }), 'FULL', 'TRIAL'],
    ['trial ended 5 days ago', sub({ status: 'TRIAL', trialEndsAt: ago(5) }), 'GRACE', 'EXPIRED'],
    ['period ended 40 days ago', sub({ currentPeriodEnd: ago(40) }), 'LOCKED', 'EXPIRED'],
    ['past due but in period', sub({ status: 'PAST_DUE' }), 'FULL', 'PAST_DUE'],
    [
      'cancelled, still paid up',
      sub({ status: 'CANCELLED', cancelledAt: ago(1) }),
      'FULL',
      'CANCELLED',
    ],
    [
      'cancelled and ended',
      sub({ status: 'CANCELLED', cancelledAt: ago(2), endedAt: ago(2) }),
      'GRACE',
      'CANCELLED',
    ],
    ['starts in the future', sub({ startsAt: ahead(1) }), 'LOCKED', 'NONE'],
  ] as const)('%s', (_label, s, mode, status) => {
    const r = effectiveSubscription(s, now, 30);
    expect(r.accessMode).toBe(mode);
    expect(r.effectiveStatus).toBe(status);
  });

  it('no subscription is locked', () => {
    expect(effectiveSubscription(null, now, 30).accessMode).toBe('LOCKED');
  });
});

describe('resolveEntitlements', () => {
  const catalog: FeatureNode[] = [
    { code: 'core', isCore: true, dependsOn: [] },
    { code: 'students', isCore: false, dependsOn: [] },
    { code: 'academics', isCore: false, dependsOn: [] },
    { code: 'attendance', isCore: false, dependsOn: ['students', 'academics'] },
    { code: 'attendance.subject', isCore: false, dependsOn: ['attendance', 'timetable'] },
    { code: 'timetable', isCore: false, dependsOn: ['academics'] },
  ];
  const grant = (featureCode: string, extra: object = {}) => ({
    featureCode,
    sourceType: 'PLAN' as const,
    sourceReference: 'sub-1',
    effect: 'GRANT' as const,
    startsAt: ago(1),
    endsAt: null,
    ...extra,
  });
  const full = effectiveSubscription(sub({}), now, 30);

  it('applies dependency closure transitively', () => {
    const r = resolveEntitlements({
      catalog,
      rows: ['students', 'attendance', 'attendance.subject', 'timetable'].map((c) => grant(c)),
      subscription: full,
      planCode: 'X',
      now,
    });
    // academics missing → attendance and timetable drop → attendance.subject drops.
    expect(r.features).toEqual(['core', 'students']);
    expect(r.blocked.map((b) => b.feature).sort()).toEqual([
      'attendance',
      'attendance.subject',
      'timetable',
    ]);
  });

  it('ignores plan rows from other subscriptions and expired rows; honours DENY', () => {
    const r = resolveEntitlements({
      catalog,
      rows: [
        grant('students'),
        grant('academics', { sourceReference: 'old-sub' }),
        grant('attendance', {
          sourceType: 'ADMIN_OVERRIDE',
          sourceReference: null,
          endsAt: ago(1),
        }),
        {
          ...grant('students'),
          sourceType: 'ADMIN_OVERRIDE' as const,
          effect: 'DENY' as const,
          sourceReference: null,
        },
      ],
      subscription: full,
      planCode: 'X',
      now,
    });
    expect(r.features).toEqual(['core']);
    expect(r.blocked).toContainEqual({ feature: 'students', reason: 'DENIED_BY_OVERRIDE' });
  });

  it('grants nothing but core outside FULL access', () => {
    const grace = effectiveSubscription(sub({ currentPeriodEnd: ago(3) }), now, 30);
    const r = resolveEntitlements({
      catalog,
      rows: [grant('students')],
      subscription: grace,
      planCode: 'X',
      now,
    });
    expect(r.accessMode).toBe('GRACE');
    expect(r.features).toEqual(['core']);
  });

  it('finds transitive dependents for impact analysis', () => {
    expect(dependentsOf(catalog, 'academics')).toEqual([
      'attendance',
      'attendance.subject',
      'timetable',
    ]);
  });
});

describe('catalog integrity', () => {
  it('every system role expands to known permissions of the right scope', () => {
    for (const role of SYSTEM_ROLES) {
      const perms = resolveSystemRolePermissions(role);
      expect(perms.length).toBeGreaterThan(0);
      if (role.scope === 'TENANT')
        expect(perms.every((p) => !p.startsWith('platform.'))).toBe(true);
    }
  });
  it('rejects unknown permission patterns', () => {
    expect(() => expandPermissionPatterns(['students.fly'])).toThrow();
  });
  it('school lifecycle transitions', () => {
    expect(canTransition('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransition('ARCHIVED', 'ACTIVE')).toBe(false);
    expect(canTransition('APPROVED', 'ACTIVE')).toBe(false);
  });
});
