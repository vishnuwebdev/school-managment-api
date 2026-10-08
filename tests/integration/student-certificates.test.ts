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
    code: 'Y-CE',
    name: 'Year CE',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  await api.post(`/academic-years/${y.body.data.id}/activate`, { complete_current: true });
  const cls = await api.post('/academic-classes', { code: 'G7CE', name: 'Grade 7', sequence: 7 });
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

async function student(enrolled = true) {
  const r = await api.post('/students', {
    first_name: 'Cert',
    last_name: uniq('Kid'),
    gender: 'FEMALE',
    date_of_birth: '2014-06-21',
    guardians: [
      {
        guardian: { first_name: 'Raj', last_name: 'Kid', phone: '+27 82 111 2222' },
        relationship_type: 'FATHER',
      },
    ],
    ...(enrolled ? { enrollment } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}

const issue = (id: string, body: object) => api.post(`/students/${id}/issued-documents`, body);

describe('wording', () => {
  it('seeds the four templates and versions edits', async () => {
    const r = await api.get('/student-document-templates');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.templates).toHaveLength(4);
    const bad = await api.put('/student-document-templates/BONAFIDE', {
      title: 'Bonafide',
      body: 'This is {{student_name}} and {{not_a_field}} for you.',
    });
    expect(bad.status).toBe(422);
    const ok = await api.put('/student-document-templates/BONAFIDE', {
      title: 'Bonafide certificate',
      body: 'Certified: {{student_name}} studies in {{class}}.',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.version).toBe(2);
  });
});

describe('issuing', () => {
  it('issues a bonafide certificate as a PDF with a serial number', async () => {
    const id = await student();
    const made = await issue(id, { kind: 'BONAFIDE' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.data.serial_number).toMatch(/^BON-\d{4}-\d{5}$/);
    const dl = await h.http
      .get(`/api/v1/students/${id}/issued-documents/${made.body.data.id}/file`)
      .set('Authorization', `Bearer ${api.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('asks before issuing a second valid copy, then marks it as a duplicate', async () => {
    const id = await student();
    await issue(id, { kind: 'CHARACTER_CERTIFICATE' });
    const again = await issue(id, { kind: 'CHARACTER_CERTIFICATE' });
    expect(again.status).toBe(409);
    const confirmed = await issue(id, { kind: 'CHARACTER_CERTIFICATE', confirm_duplicate: true });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.data.is_duplicate).toBe(true);
  });

  it('issues a transfer certificate only after the student has left', async () => {
    const id = await student();
    expect((await issue(id, { kind: 'TRANSFER_CERTIFICATE' })).status).toBe(422);
    await api.post(`/students/${id}/transfer`, {
      reason: 'Moving',
      destination_school: 'Hillside High',
      effective_date: '2026-09-01',
    });
    const tc = await issue(id, { kind: 'TRANSFER_CERTIFICATE' });
    expect(tc.status, JSON.stringify(tc.body)).toBe(201);
    expect(tc.body.data.serial_number).toMatch(/^TRC-/);
    // A student who has left no longer gets an ID card or bonafide.
    expect((await issue(id, { kind: 'ID_CARD' })).status).toBe(422);
    expect((await issue(id, { kind: 'BONAFIDE' })).status).toBe(422);
  });

  it('issues a two-sided ID card to an active student', async () => {
    const id = await student();
    const card = await issue(id, { kind: 'ID_CARD' });
    expect(card.status, JSON.stringify(card.body)).toBe(201);
    expect(card.body.data.serial_number).toMatch(/^IDC-/);
  });

  it('voids rather than edits, and keeps the record', async () => {
    const id = await student();
    const made = await issue(id, { kind: 'BONAFIDE' });
    const docId = made.body.data.id as string;
    expect((await api.post(`/students/${id}/issued-documents/${docId}/void`, {})).status).toBe(422);
    const v = await api.post(`/students/${id}/issued-documents/${docId}/void`, {
      reason: 'Wrong class printed',
    });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.data.voided_at).not.toBeNull();
    expect(
      (await api.post(`/students/${id}/issued-documents/${docId}/void`, { reason: 'Again' }))
        .status,
    ).toBe(422);
    const list = await api.get(`/students/${id}/issued-documents`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].void_reason).toBe('Wrong class printed');
    // After a void a fresh one can be issued without confirmation.
    expect((await issue(id, { kind: 'BONAFIDE' })).status).toBe(201);
  });

  it('keeps schools apart', async () => {
    const id = await student();
    const made = await issue(id, { kind: 'BONAFIDE' });
    const other = await B.admin.api.get(
      `/students/${id}/issued-documents/${made.body.data.id}/file`,
    );
    expect(other.status).toBe(404);
    expect((await B.admin.api.get(`/students/${id}/issued-documents`)).status).toBe(404);
  });
});
