import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let enrollment: { academic_year_id: string; class_id: string; section_id: string };

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  const y = await api.post('/academic-years', {
    code: 'Y-EX',
    name: 'Year EX',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  await api.post(`/academic-years/${y.body.data.id}/activate`, { complete_current: true });
  const cls = await api.post('/academic-classes', { code: 'G7EX', name: 'Grade 7', sequence: 7 });
  const sec = await api.post(`/academic-years/${y.body.data.id}/sections`, {
    class_id: cls.body.data.id,
    code: 'A',
    name: 'Section A',
  });
  enrollment = {
    academic_year_id: y.body.data.id,
    class_id: cls.body.data.id,
    section_id: sec.body.data.id,
  };
});
afterAll(() => h.close());

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

const putFile = (a: Api, url: string, body: Buffer) =>
  h.http
    .put(`/api/v1${url}`)
    .set('Authorization', `Bearer ${a.token}`)
    .set('Content-Type', 'application/pdf')
    .send(body);

async function newStudent(a: Api = api, enrolled = false) {
  const made = await a.post('/students', {
    first_name: 'Exit',
    last_name: uniq('S'),
    ...(enrolled ? { enrollment } : {}),
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.data.id as string;
}

describe('withdrawal and transfer details', () => {
  it('records reason, remarks, date and destination, and keeps them after archiving', async () => {
    const id = await newStudent(api, true);
    const bad = await api.post(`/students/${id}/transfer`, {
      reason: 'Moving',
      effective_date: '2999-01-01',
    });
    expect(bad.status).toBe(422);

    const tr = await api.post(`/students/${id}/transfer`, {
      reason: 'Family moved',
      remarks: 'Parents asked for the certificate',
      destination_school: 'Hillside High',
      effective_date: '2026-09-01',
    });
    expect(tr.status, JSON.stringify(tr.body)).toBe(200);

    const exit = await api.get(`/students/${id}/exit`);
    expect(exit.status).toBe(200);
    expect(exit.body.data.current).toMatchObject({
      kind: 'TRANSFERRED',
      exit_date: '2026-09-01',
      reason: 'Family moved',
      destination_school: 'Hillside High',
      has_document: false,
    });

    const arch = await api.post(`/students/${id}/archive`, {});
    expect(arch.status, JSON.stringify(arch.body)).toBe(200);
    expect((await api.get(`/students/${id}/exit`)).body.data.current.kind).toBe('TRANSFERRED');
  });

  it('rejects remarks or a destination where they do not belong', async () => {
    const id = await newStudent();
    const wrong = await api.post(`/students/${id}/withdraw`, {
      reason: 'Left',
      destination_school: 'Somewhere',
    });
    expect(wrong.status).toBe(422);
  });

  it('attaches a supporting document and downloads it', async () => {
    const id = await newStudent();
    expect((await putFile(api, `/students/${id}/exit-document?filename=x.pdf`, PDF)).status).toBe(
      422,
    );
    await api.post(`/students/${id}/withdraw`, { reason: 'Relocated' });
    const up = await putFile(api, `/students/${id}/exit-document?filename=letter.pdf`, PDF);
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const exit = await api.get(`/students/${id}/exit`);
    expect(exit.body.data.current.document_name).toBe('letter.pdf');
    const dl = await api.get(`/students/${id}/exit/document`);
    expect(dl.status).toBe(200);
  });

  it('closes the exit on reinstate and keeps it in the earlier list', async () => {
    const id = await newStudent();
    await api.post(`/students/${id}/withdraw`, { reason: 'Illness' });
    const back = await api.post(`/students/${id}/reinstate`, { reason: 'Returned' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const exit = await api.get(`/students/${id}/exit`);
    expect(exit.body.data.current).toBeNull();
    expect(exit.body.data.all).toHaveLength(1);
    expect(exit.body.data.all[0].reinstated_at).not.toBeNull();
  });

  it('keeps schools apart', async () => {
    const id = await newStudent();
    await api.post(`/students/${id}/withdraw`, { reason: 'Left' });
    expect((await B.admin.api.get(`/students/${id}/exit`)).status).toBe(404);
  });
});
