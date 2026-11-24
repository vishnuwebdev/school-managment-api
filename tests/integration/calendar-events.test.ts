import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

/** School calendar events, exams and meetings (/calendar/events). */
let h: Harness;
let api: Api;
let classId: string;

beforeAll(async () => {
  h = await createHarness();
  const A = await h.provisionSchool({ plan: 'STANDARD' });
  api = A.admin.api;
  classId = (await api.post('/academic-classes', { code: uniq('G'), name: 'Grade 9', sequence: 9 }))
    .body.data.id;
});
afterAll(() => h.close());

const base = {
  type: 'MEETING',
  title: 'Staff meeting',
  start_date: '2026-10-20',
  end_date: '2026-10-20',
  start_time: '14:00',
  end_time: '15:00',
  audience: 'STAFF',
};

describe('calendar events', () => {
  it('adds, edits, lists and cancels an event', async () => {
    const created = await api.post('/calendar/events', {
      ...base,
      staff_action: 'Bring Term 4 mark sheets',
      action_link: 'MARKS',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const e = created.body.data;
    expect(e).toMatchObject({ type: 'MEETING', start_time: '14:00', end_time: '15:00', audience: 'STAFF' });
    expect(e.action_link).toBe('MARKS');

    const edited = await api.patch(`/calendar/events/${e.id}`, {
      title: 'Grade heads meeting',
      start_time: null,
      end_time: null,
      version: e.version,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data.title).toBe('Grade heads meeting');
    expect(edited.body.data.start_time).toBeNull();

    // Stale version.
    expect(code(await api.patch(`/calendar/events/${e.id}`, { title: 'X y', version: e.version }))).toBe(
      'CONFLICT',
    );

    const list = await api.get('/calendar/events?from=2026-10-01&to=2026-10-31&type=MEETING');
    expect(list.body.data.map((x: { id: string }) => x.id)).toContain(e.id);

    const cancelled = await api.post(`/calendar/events/${e.id}/cancel`, {
      version: edited.body.data.version,
      reason: 'Moved online',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    const active = await api.get('/calendar/events?from=2026-10-01&to=2026-10-31');
    expect(active.body.data.map((x: { id: string }) => x.id)).not.toContain(e.id);
  });

  it('checks dates, times and classes', async () => {
    expect(code(await api.post('/calendar/events', { ...base, end_date: '2026-10-19' }))).toBe(
      'OPERATION_NOT_ALLOWED',
    );
    expect(code(await api.post('/calendar/events', { ...base, end_time: null }))).toBe(
      'OPERATION_NOT_ALLOWED',
    );
    expect(code(await api.post('/calendar/events', { ...base, end_time: '13:00' }))).toBe(
      'OPERATION_NOT_ALLOWED',
    );
    expect(code(await api.post('/calendar/events', { ...base, audience: 'CLASSES' }))).toBe(
      'OPERATION_NOT_ALLOWED',
    );
    const ok = await api.post('/calendar/events', { ...base, audience: 'CLASSES', class_ids: [classId] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('never makes a day off', async () => {
    await api.post('/calendar/events', {
      ...base,
      type: 'EVENT',
      title: 'Sports day',
      start_date: '2026-10-21',
      end_date: '2026-10-21',
      audience: 'ALL',
    });
    const w = await api.get('/calendar/working-days?from=2026-10-21&to=2026-10-21');
    expect(w.body.data.working_days).toBe(1);
  });
});

describe('calendar categories', () => {
  const cat = async (code: string) =>
    ((await api.get('/calendar/categories')).body.data as { id: string; code: string; closes_school: boolean }[]).find(
      (c) => c.code === code,
    )!;

  it('gives every school the built-in categories with colours', async () => {
    const list = (await api.get('/calendar/categories')).body.data as { code: string; color: string; closes_school: boolean }[];
    expect(list.map((c) => c.code)).toEqual(
      expect.arrayContaining(['HOLIDAY', 'VACATION', 'EXAM', 'SPORTS', 'ACTIVITY', 'OCCASION', 'MEETING', 'INFO']),
    );
    expect(list.find((c) => c.code === 'HOLIDAY')).toMatchObject({ closes_school: true, color: '#F43F5E' });
    expect(list.find((c) => c.code === 'SPORTS')).toMatchObject({ closes_school: false });
  });

  it('an entry in a closing category is a day off; several entries can share a day', async () => {
    const holiday = await cat('HOLIDAY');
    const exam = await cat('EXAM');
    const day = { start_date: '2026-11-10', end_date: '2026-11-10', audience: 'ALL' };
    expect((await api.post('/calendar/events', { ...day, category_id: holiday.id, title: 'Diwali' })).status).toBe(201);
    expect((await api.post('/calendar/events', { ...day, category_id: exam.id, title: 'Make-up test' })).status).toBe(201);
    const w = await api.get('/calendar/working-days?from=2026-11-10&to=2026-11-10');
    expect(w.body.data.working_days).toBe(0);
    expect(w.body.data.off_days[0]).toMatchObject({ reason: 'HOLIDAY', name: 'Diwali' });
    const onDay = (await api.get('/calendar/events?from=2026-11-10&to=2026-11-10')).body.data as { title: string }[];
    expect(onDay.map((e) => e.title)).toEqual(expect.arrayContaining(['Diwali', 'Make-up test']));
  });

  it('custom categories, and switching "closes school" changes the day count', async () => {
    const created = await api.post('/calendar/categories', { name: 'Founders day', color: '#06b6d4', closes_school: false });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ color: '#06B6D4', is_system: false });
    expect(code(await api.post('/calendar/categories', { name: 'founders DAY', color: '#06B6D4' }))).toBe('DUPLICATE_RESOURCE');
    await api.post('/calendar/events', {
      category_id: created.body.data.id,
      title: 'Founders day',
      start_date: '2026-11-17',
      end_date: '2026-11-17',
      audience: 'ALL',
    });
    const count = async () => (await api.get('/calendar/working-days?from=2026-11-17&to=2026-11-17')).body.data.working_days;
    expect(await count()).toBe(1);
    const upd = await api.patch(`/calendar/categories/${created.body.data.id}`, { closes_school: true, version: created.body.data.version });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(await count()).toBe(0);
  });

  it('section audiences need sections', async () => {
    const sports = await cat('SPORTS');
    expect(
      code(
        await api.post('/calendar/events', {
          category_id: sports.id,
          title: 'Inter-house final',
          start_date: '2026-11-18',
          end_date: '2026-11-18',
          audience: 'SECTIONS',
        }),
      ),
    ).toBe('OPERATION_NOT_ALLOWED');
  });
});
