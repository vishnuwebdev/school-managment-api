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

const upload = (a: Api, url: string, body: Buffer | string, type: string) =>
  h.http
    .post(`/api/v1${url}`)
    .set('Authorization', `Bearer ${a.token}`)
    .set('Content-Type', type)
    .send(Buffer.isBuffer(body) ? body : Buffer.from(body));

describe('retired status', () => {
  it('retires an active staff member with an exit date, reason optional, then archives', async () => {
    const made = await api.post('/teachers', { first_name: 'Old', last_name: uniq('Hand') });
    const id = made.body.data.id;
    const r = await api.post(`/teachers/${id}/retire`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('RETIRED');
    expect(r.body.data.exit_reason).toBe('Retired');
    const again = await api.post(`/teachers/${id}/retire`, {});
    expect(again.status).toBe(422);
    const arch = await api.post(`/teachers/${id}/archive`, {});
    expect(arch.body.data.status).toBe('ARCHIVED');
  });
});

describe('department and designation lists', () => {
  it('seeds from existing values, enforces the list, and renames through to staff', async () => {
    const first = await api.post('/teachers', {
      first_name: 'Dept',
      last_name: uniq('One'),
      department: 'Science',
    });
    expect(first.status).toBe(201);
    const list = await api.get('/staff-lookups?kind=DEPARTMENT');
    expect(list.body.data.map((l: { name: string }) => l.name)).toContain('Science');

    const bad = await api.post('/teachers', {
      first_name: 'Dept',
      last_name: uniq('Two'),
      department: 'Astrology',
    });
    expect(bad.status).toBe(422);

    const added = await api.post('/staff-lookups', { kind: 'DEPARTMENT', name: 'Arts' });
    expect(added.status).toBe(201);
    const dup = await api.post('/staff-lookups', { kind: 'DEPARTMENT', name: 'Arts' });
    expect(dup.status).toBe(409);
    const ok = await api.post('/teachers', {
      first_name: 'Dept',
      last_name: uniq('Three'),
      department: 'Arts',
    });
    expect(ok.status).toBe(201);

    const sci = list.body.data.find((l: { name: string }) => l.name === 'Science');
    await api.patch(`/staff-lookups/${sci.id}`, { name: 'Sciences' });
    const got = await api.get(`/teachers/${first.body.data.id}`);
    expect(got.body.data.department).toBe('Sciences');

    await api.patch(`/staff-lookups/${added.body.data.id}`, { is_active: false });
    const off = await api.post('/teachers', {
      first_name: 'Dept',
      last_name: uniq('Four'),
      department: 'Arts',
    });
    expect(off.status).toBe(422);
  });

  it('keeps each school list separate', async () => {
    const other = await B.admin.api.get('/staff-lookups?kind=DEPARTMENT');
    expect(other.body.data.map((l: { name: string }) => l.name)).not.toContain('Sciences');
  });
});

describe('extra staff fields', () => {
  it('stores the ID number encrypted and only ever shows the last four characters', async () => {
    const made = await api.post('/teachers', {
      first_name: 'Id',
      last_name: uniq('Holder'),
      id_number: '8001015009087',
      emergency_contact_name: 'Sam',
      emergency_contact_phone: '+27 82 000 0000',
      emergency_contact_relation: 'Spouse',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const t = made.body.data;
    expect(t.id_number_masked).toBe('••••9087');
    expect(t.has_id_number).toBe(true);
    expect(JSON.stringify(t)).not.toContain('8001015009087');
    expect(t.emergency_contact_name).toBe('Sam');
    const cleared = await api.patch(`/teachers/${t.id}`, { version: t.version, id_number: null });
    expect(cleared.body.data.has_id_number).toBe(false);
  });

  it('validates the reporting manager', async () => {
    const boss = await api.post('/teachers', { first_name: 'Boss', last_name: uniq('B') });
    const rep = await api.post('/teachers', {
      first_name: 'Rep',
      last_name: uniq('R'),
      reporting_manager_id: boss.body.data.id,
    });
    expect(rep.status).toBe(201);
    expect(rep.body.data.reporting_manager.id).toBe(boss.body.data.id);
    const self = await api.patch(`/teachers/${rep.body.data.id}`, {
      version: rep.body.data.version,
      reporting_manager_id: rep.body.data.id,
    });
    expect(self.status).toBe(422);
    const loop = await api.patch(`/teachers/${boss.body.data.id}`, {
      version: boss.body.data.version,
      reporting_manager_id: rep.body.data.id,
    });
    expect(loop.status).toBe(422);
    const foreign = await B.admin.api.post('/teachers', {
      first_name: 'X',
      last_name: uniq('X'),
      reporting_manager_id: boss.body.data.id,
    });
    expect(foreign.status).toBe(422);
  });
});

describe('staff import', () => {
  const csv = (rows: string[]) =>
    ['first_name,last_name,email,staff_type,joining_date', ...rows].join('\n') + '\n';

  it('checks first, then imports everything or nothing', async () => {
    const tag = uniq('imp').toLowerCase();
    const good = csv([
      `Ann,Import${tag},ann.${tag}@example.com,TEACHING,2026-01-05`,
      `Bob,Import${tag},bob.${tag}@example.com,non-teaching,2026-01-06`,
    ]);
    const dry = await upload(api, '/teachers/import', good, 'text/csv');
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.data).toMatchObject({
      dry_run: true,
      total: 2,
      valid: 2,
      invalid: 0,
      created: 0,
    });
    const before = await api.get(`/teachers?search=Import${tag}`);
    expect(before.body.data).toHaveLength(0);

    const bad = csv([
      `Cy,Import${tag},cy.${tag}@example.com,TEACHING,2026-01-05`,
      `Di,Import${tag},not-an-email,TEACHING,2026-13-45`,
    ]);
    const refused = await upload(api, '/teachers/import?commit=true', bad, 'text/csv');
    expect(refused.status).toBe(422);
    const stillNone = await api.get(`/teachers?search=Import${tag}`);
    expect(stillNone.body.data).toHaveLength(0);

    const done = await upload(api, '/teachers/import?commit=true', good, 'text/csv');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.created).toBe(2);
    const after = await api.get(`/teachers?search=Import${tag}`);
    expect(after.body.data).toHaveLength(2);

    const again = await upload(api, '/teachers/import', good, 'text/csv');
    expect(again.body.data.invalid).toBe(2);
    expect(again.body.data.rows[0].errors.join(' ')).toMatch(/duplicate/i);
  });

  it('flags repeated people inside one file', async () => {
    const tag = uniq('rep').toLowerCase();
    const res = await upload(
      api,
      '/teachers/import',
      csv([
        `Eve,Rep${tag},eve.${tag}@example.com,TEACHING,`,
        `Eva,Rep${tag},eve.${tag}@example.com,TEACHING,`,
      ]),
      'text/csv',
    );
    expect(res.body.data.rows[1].errors.join(' ')).toMatch(/same person as row 2/);
  });

  it('serves a template and rejects unknown columns', async () => {
    const t = await api.get('/teachers/import/template');
    expect(t.status).toBe(200);
    const unk = await upload(
      api,
      '/teachers/import',
      'first_name,last_name,salary\nA,B,1\n',
      'text/csv',
    );
    expect(unk.status).toBe(422);
  });
});

describe('staff reports', () => {
  it('returns tabular reports and CSV, scoped to the school', async () => {
    const dir = await api.get('/staff-reports/directory');
    expect(dir.status, JSON.stringify(dir.body)).toBe(200);
    expect(dir.body.data.columns.length).toBeGreaterThan(3);
    expect(dir.body.data.rows.length).toBeGreaterThan(0);
    const dept = await api.get('/staff-reports/by-department');
    expect(dept.status).toBe(200);
    for (const r of ['qualifications', 'expiring-documents', 'leave-summary']) {
      const x = await api.get(`/staff-reports/${r}`);
      expect(x.status, r).toBe(200);
    }
    const csv = await api.get('/staff-reports/directory?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const other = await B.admin.api.get('/staff-reports/directory');
    expect(other.body.data.rows.length).toBe(0);
  });
});
