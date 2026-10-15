import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/catalog/permissions.js';
import { SYSTEM_ROLES } from '../../src/catalog/roles.js';
import {
  teacherAppRoutes,
  type TeacherAppDeps,
} from '../../src/modules/teacher-app/teacher-app.routes.js';

// Route definitions only; handlers are not called.
const routes = teacherAppRoutes({} as TeacherAppDeps);

describe('teacher app routes', () => {
  it('all live under /teacher and need a school context', () => {
    for (const r of routes) {
      expect(r.path.startsWith('/teacher/')).toBe(true);
      expect(r.access).toBe('tenant');
    }
  });

  it('all require teacher_app.use plus the permission of what they wrap', () => {
    for (const r of routes) {
      expect(r.permissions?.[0]).toBe('teacher_app.use');
      expect(r.permissions!.length).toBeGreaterThan(1);
    }
  });

  it('teacher_app.use belongs to the paid teacher app feature and the TEACHER role', () => {
    const p = PERMISSIONS.find((x) => x.code === 'teacher_app.use');
    expect(p?.feature).toBe('teachers.mobile_app');
    expect(p?.scopeSupport).toBe('NEUTRAL');
    const teacher = SYSTEM_ROLES.find((r) => r.code === 'TEACHER');
    expect(teacher?.permissions).toContain('teacher_app.use');
  });

  it('every TEACHER-role permission a route needs is held by the TEACHER role', () => {
    const teacher = SYSTEM_ROLES.find((r) => r.code === 'TEACHER')!;
    for (const r of routes)
      for (const p of r.permissions ?? []) expect(teacher.permissions).toContain(p);
  });
});
