import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let classCode: string;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  api = A.admin.api;
  const y = await api.post('/academic-years', {
    code: 'Y-IM',
    name: 'Year IM',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  await api.post(`/academic-years/${y.body.data.id}/activate`, { complete_current: true });
  classCode = 'G7IM';
  const cls = await api.post('/academic-classes', {
    code: classCode,
    name: 'Grade 7',
    sequence: 7,
  });
  await api.post(`/academic-years/${y.body.data.id}/sections`, {
    class_id: cls.body.data.id,
    code: 'A',
    name: 'Section A',
    capacity: 2,
  });
});
afterAll(() => h.close());

async function sheet(rows: Record<string, string>[]) {
  const headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Students');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(headers.map((k) => r[k] ?? ''));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const send = (body: Buffer, qs = '', contentType = XLSX) =>
  h.http
    .post(`/api/v1/students/import${qs}`)
    .set('Authorization', `Bearer ${api.token}`)
    .set('Content-Type', contentType)
    .send(body);

describe('student import', () => {
  it('serves a template', async () => {
    const res = await h.http
      .get('/api/v1/students/import/template')
      .set('Authorization', `Bearer ${api.token}`);
    expect(res.status).toBe(200);
  });

  it('reports row-by-row errors without saving anything', async () => {
    const last = uniq('Imp');
    const file = await sheet([
      { first_name: 'Good', last_name: last, class_code: classCode, section_code: 'A' },
      { first_name: 'Bad', last_name: last, gender: 'ROBOT' },
      { first_name: 'Lost', last_name: last, class_code: 'NOPE' },
    ]);
    const dry = await send(file);
    expect(dry.status, JSON.stringify(dry.body)).toBe(200);
    expect(dry.body.data).toMatchObject({ dry_run: true, total: 3, valid: 1, invalid: 2 });
    expect(dry.body.data.rows[1].errors.join(' ')).toMatch(/gender/);
    expect(dry.body.data.rows[2].errors.join(' ')).toMatch(/class_code/);

    const commit = await send(file, '?commit=true');
    expect(commit.status).toBe(422);
    const list = await api.get(`/students?search=${last}`);
    expect(list.body.data).toHaveLength(0);
  });

  it('imports everything in one go, sharing a parent between siblings', async () => {
    const last = uniq('Sib');
    const phone = '+27 82 555 0101';
    const file = await sheet([
      {
        first_name: 'Ann',
        last_name: last,
        class_code: classCode,
        section_code: 'A',
        father_name: `Raj ${last}`,
        father_phone: phone,
      },
      {
        first_name: 'Ben',
        last_name: last,
        class_code: classCode,
        section_code: 'A',
        father_name: `Raj ${last}`,
        father_phone: phone,
      },
    ]);
    const res = await send(file, '?commit=true');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.created).toBe(2);
    const list = await api.get(`/students?search=${last}`);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data[0].status).toBe('ACTIVE');
    const guardians = await api.get(`/guardians?search=${last}`);
    expect(guardians.body.data).toHaveLength(1);
  });

  it('flags a full section and rejects non-xlsx uploads', async () => {
    const last = uniq('Full');
    const file = await sheet(
      [1, 2, 3].map((n) => ({
        first_name: `K${n}`,
        last_name: last,
        class_code: classCode,
        section_code: 'A',
      })),
    );
    const dry = await send(file);
    // Two seats were used by the previous test, so every row is over capacity here.
    expect(dry.body.data.invalid).toBeGreaterThan(0);
    expect(
      dry.body.data.rows.some((r: { errors: string[] }) => r.errors.join().includes('full')),
    ).toBe(true);
    const bad = await send(Buffer.from('a,b\n1,2'), '', 'application/pdf');
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});
