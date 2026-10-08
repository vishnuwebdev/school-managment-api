import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
});
afterAll(() => h.close());

describe('houses and numbering settings', () => {
  it('manages houses per school', async () => {
    const made = await api.post('/student-houses', { name: 'Red' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await api.post('/student-houses', { name: 'Red' })).status).toBe(409);
    const list = await api.get('/student-houses');
    expect(list.body.data.map((x: { name: string }) => x.name)).toContain('Red');
    expect((await B.admin.api.get('/student-houses')).body.data).toHaveLength(0);
    const off = await api.patch(`/student-houses/${made.body.data.id}`, { is_active: false });
    expect(off.body.data.is_active).toBe(false);
    expect((await api.get('/student-houses')).body.data).toHaveLength(0);
  });

  it('defaults to automatic admission numbers and can switch to manual entry', async () => {
    expect((await api.get('/student-settings')).body.data.admission_number_mode).toBe('AUTO');
    const auto = await api.post('/students', { first_name: 'Auto', last_name: uniq('N') });
    expect(auto.body.data.admission_number).toMatch(/^ADM-\d{4}-\d{5}$/);

    const sw = await B.admin.api.put('/student-settings', { admission_number_mode: 'MANUAL' });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    const none = await B.admin.api.post('/students', { first_name: 'No', last_name: uniq('N') });
    expect(none.status).toBe(422);
    const num = `M${Date.now().toString(36)}`.toUpperCase();
    const ok = await B.admin.api.post('/students', {
      first_name: 'Man',
      last_name: uniq('N'),
      admission_number: num,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.admission_number).toBe(num);
    const dup = await B.admin.api.post('/students', {
      first_name: 'Man2',
      last_name: uniq('N'),
      admission_number: num,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.field).toBe('admission_number');
  });
});

describe('extra student fields', () => {
  it('stores the new fields and filters the list by admission type', async () => {
    const house = await api.post('/student-houses', { name: uniq('Blue') });
    const made = await api.post('/students', {
      first_name: 'Full',
      last_name: uniq('Rec'),
      blood_group: 'O+',
      house_id: house.body.data.id,
      previous_school: 'Old School',
      category: 'General',
      admission_date: '2026-01-10',
      admission_type: 'TRANSFER_IN',
      government_id: '1234567890',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const s = made.body.data;
    expect(s).toMatchObject({
      blood_group: 'O+',
      previous_school: 'Old School',
      category: 'General',
      admission_date: '2026-01-10',
      admission_type: 'TRANSFER_IN',
      government_id_masked: '••••7890',
      has_government_id: true,
    });
    expect(s.house.id).toBe(house.body.data.id);
    expect(JSON.stringify(s)).not.toContain('1234567890');

    const list = await api.get('/students?admission_type=TRANSFER_IN');
    expect(list.body.data.map((x: { id: string }) => x.id)).toContain(s.id);
    const none = await api.get('/students?admission_type=RE_ADMISSION');
    expect(none.body.data.map((x: { id: string }) => x.id)).not.toContain(s.id);

    const full = await api.get(`/students/${s.id}/government-id`);
    expect(full.body.data.government_id).toBe('1234567890');
    const upd = await api.patch(`/students/${s.id}`, { version: s.version, government_id: null });
    expect(upd.body.data.has_government_id).toBe(false);
  });

  it('rejects a house from another school and accepts father and mother links', async () => {
    const foreign = await B.admin.api.post('/student-houses', { name: uniq('Green') });
    const bad = await api.post('/students', {
      first_name: 'X',
      last_name: uniq('Y'),
      house_id: foreign.body.data.id,
    });
    expect(bad.status).toBe(422);
    const ok = await api.post('/students', {
      first_name: 'Kid',
      last_name: uniq('Fam'),
      guardians: [
        {
          guardian: { first_name: 'Dad', last_name: 'Fam' },
          relationship_type: 'FATHER',
          is_primary: true,
        },
        { guardian: { first_name: 'Mum', last_name: 'Fam' }, relationship_type: 'MOTHER' },
      ],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const types = ok.body.data.guardians.map(
      (g: { relationship_type: string }) => g.relationship_type,
    );
    expect(types).toEqual(expect.arrayContaining(['FATHER', 'MOTHER']));
  });
});
