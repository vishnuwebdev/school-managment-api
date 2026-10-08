import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/catalog/permissions.js';
import { SYSTEM_ROLES } from '../../src/catalog/roles.js';
import {
  applyScopePolicy,
  platformGrantsInSchool,
  supportsScope,
  unsupportedPermissions,
} from '../../src/modules/access/scope-policy.js';

const sec = (ids: string[]) => ({ type: 'ASSIGNED_SECTION' as const, ref: { section_ids: ids } });

describe('scope policy (D55)', () => {
  it('drops narrower grants of school-wide-only permissions', () => {
    const out = applyScopePolicy({
      'members.read': [sec(['s1'])],
      'audit.read': [{ type: 'OWN_RECORD', ref: null }],
      'roles.assign': [sec(['s1']), { type: 'ALL_TENANT', ref: null }],
    });
    expect(out['members.read']).toBeUndefined();
    expect(out['audit.read']).toBeUndefined();
    expect(out['roles.assign']).toEqual([{ type: 'ALL_TENANT', ref: null }]);
  });

  it('keeps section/class grants for placement permissions, never other narrow types', () => {
    const out = applyScopePolicy({
      'students.read': [sec(['s1']), { type: 'ASSIGNED_CLASS', ref: { class_ids: ['c1'] } }],
      'attendance.read': [{ type: 'OWN_RECORD', ref: null }],
    });
    expect(out['students.read']).toHaveLength(2);
    expect(out['attendance.read']).toBeUndefined();
  });

  it('treats reference data as school-wide and own-record permissions as given', () => {
    const out = applyScopePolicy({
      'academics.read': [sec(['s1'])],
      'teachers.read': [sec(['s1'])],
    });
    expect(out['academics.read']).toEqual([{ type: 'ALL_TENANT', ref: null }]);
    expect(out['teachers.read']).toEqual([sec(['s1'])]);
  });

  it('gives platform staff inside an allowed school school-wide tenant grants', () => {
    const out = platformGrantsInSchool(
      { 'students.read': [{ type: 'SELECTED_TENANTS', ref: { tenant_ids: ['t1'] } }] },
      ['students.read'],
    );
    expect(out).toEqual({ 'students.read': [{ type: 'ALL_TENANT', ref: null }] });
  });

  it('lists the permissions a scope would not confer', () => {
    expect(
      unsupportedPermissions(
        ['students.read', 'members.read', 'platform.users.manage'],
        'ASSIGNED_SECTION',
      ),
    ).toEqual(['members.read']);
    expect(supportsScope('TENANT_WIDE', 'ALL_TENANT')).toBe(true);
  });

  it('the Teacher system role can be limited to sections and classes', () => {
    const teacher = SYSTEM_ROLES.find((r) => r.code === 'TEACHER')!;
    expect(unsupportedPermissions(teacher.permissions, 'ASSIGNED_SECTION')).toEqual([]);
    expect(unsupportedPermissions(teacher.permissions, 'ASSIGNED_CLASS')).toEqual([]);
  });

  it('every PLACEMENT permission used by a route is handled by its module', () => {
    // A permission may only claim section scope if some service passes it to a
    // scope helper / loader (studentScope, feeScope, loadStudent, …). Routes alone
    // do not narrow anything, so this guards against widening by omission.
    const root = fileURLToPath(new URL('../../src/modules', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    const routes = files
      .filter((f) => f.endsWith('.routes.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const services = files
      .filter((f) => !f.endsWith('.routes.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const missing = PERMISSIONS.filter((p) => p.scopeSupport === 'PLACEMENT')
      .map((p) => p.code)
      .filter((c) => routes.includes(`'${c}'`) && !services.includes(`'${c}'`));
    expect(missing).toEqual([]);
  });

  it('every tenant permission declares its scope support', () => {
    for (const p of PERMISSIONS.filter((x) => x.scope === 'TENANT'))
      expect(['TENANT_WIDE', 'NEUTRAL', 'PLACEMENT', 'OWN']).toContain(p.scopeSupport);
  });
});
