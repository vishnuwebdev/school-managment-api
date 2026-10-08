import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, uniq, type Api, type Harness } from '../helpers.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['provisionSchool']>>;
let B: Awaited<ReturnType<Harness['provisionSchool']>>;
let api: Api;
let studentId: string;

beforeAll(async () => {
  h = await createHarness();
  A = await h.provisionSchool();
  B = await h.provisionSchool();
  api = A.admin.api;
  const made = await api.post('/students', { first_name: 'Doc', last_name: uniq('Student') });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  studentId = made.body.data.id;
});
afterAll(() => h.close());

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

const send = (a: Api, method: 'post' | 'put', url: string, body: Buffer, type: string) =>
  h.http[method](`/api/v1${url}`)
    .set('Authorization', `Bearer ${a.token}`)
    .set('Content-Type', type)
    .send(body);

const download = (a: Api, url: string) =>
  h.http
    .get(`/api/v1${url}`)
    .set('Authorization', `Bearer ${a.token}`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

describe('document types', () => {
  it('seeds the standard types and lets the school add and switch off its own', async () => {
    const list = await api.get('/student-document-types');
    expect(list.status).toBe(200);
    const codes = list.body.data.map((t: { code: string }) => t.code);
    expect(codes).toEqual(expect.arrayContaining(['BIRTH_CERTIFICATE', 'ADDRESS_PROOF', 'OTHER']));

    const added = await api.post('/student-document-types', {
      code: 'caste_certificate',
      name: 'Caste certificate',
      is_required: true,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data.code).toBe('CASTE_CERTIFICATE');
    const dup = await api.post('/student-document-types', {
      code: 'CASTE_CERTIFICATE',
      name: 'Again',
    });
    expect(dup.status).toBe(409);

    const off = await api.patch(`/student-document-types/${added.body.data.id}`, {
      is_active: false,
    });
    expect(off.body.data.is_active).toBe(false);
    const active = await api.get('/student-document-types');
    expect(active.body.data.map((t: { code: string }) => t.code)).not.toContain(
      'CASTE_CERTIFICATE',
    );
  });

  it('is separate per school', async () => {
    const b = await B.admin.api.get('/student-document-types');
    expect(b.body.data.map((t: { code: string }) => t.code)).not.toContain('CASTE_CERTIFICATE');
  });
});

describe('student documents', () => {
  it('flags missing required documents, then clears them on upload', async () => {
    const before = await api.get(`/students/${studentId}/documents`);
    expect(before.status).toBe(200);
    expect(before.body.data.missing_required).toEqual(
      expect.arrayContaining(['Birth certificate', 'Address proof']),
    );

    const up = await send(
      api,
      'post',
      `/students/${studentId}/documents?type=BIRTH_CERTIFICATE&filename=birth.pdf`,
      PDF,
      'application/pdf',
    );
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const after = await api.get(`/students/${studentId}/documents`);
    expect(after.body.data.missing_required).not.toContain('Birth certificate');
    const birth = after.body.data.types.find(
      (t: { code: string }) => t.code === 'BIRTH_CERTIFICATE',
    );
    expect(birth.status).toBe('UPLOADED');
    expect(birth.documents).toHaveLength(1);
    expect(birth.documents[0].file_name).toBe('birth.pdf');
  });

  it('replaces a single-file type, keeps several for "Other", and records history', async () => {
    const again = await send(
      api,
      'post',
      `/students/${studentId}/documents?type=BIRTH_CERTIFICATE`,
      PNG,
      'image/png',
    );
    expect(again.body.data.replaced).toBe(true);
    const list = await api.get(`/students/${studentId}/documents`);
    const birth = list.body.data.types.find(
      (t: { code: string }) => t.code === 'BIRTH_CERTIFICATE',
    );
    expect(birth.documents).toHaveLength(1);

    await send(
      api,
      'post',
      `/students/${studentId}/documents?type=OTHER&filename=a.pdf`,
      PDF,
      'application/pdf',
    );
    await send(
      api,
      'post',
      `/students/${studentId}/documents?type=OTHER&filename=b.pdf`,
      PDF,
      'application/pdf',
    );
    const other = (await api.get(`/students/${studentId}/documents`)).body.data.types.find(
      (t: { code: string }) => t.code === 'OTHER',
    );
    expect(other.documents).toHaveLength(2);

    const events = (await api.get(`/students/${studentId}/history`)).body.data.map(
      (e: { event_type: string }) => e.event_type,
    );
    expect(events).toEqual(
      expect.arrayContaining(['STUDENT_DOCUMENT_ADDED', 'STUDENT_DOCUMENT_REPLACED']),
    );
  });

  it('downloads the file to the same school only', async () => {
    const list = await api.get(`/students/${studentId}/documents`);
    const doc = list.body.data.types.find((t: { code: string }) => t.code === 'BIRTH_CERTIFICATE')
      .documents[0];
    const got = await download(api, `/students/${studentId}/documents/${doc.id}/file`);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toContain('image/png');
    expect((got.body as Buffer).equals(PNG)).toBe(true);
    const other = await B.admin.api.get(`/students/${studentId}/documents/${doc.id}/file`);
    expect(other.status).toBe(404);
  });

  it('validates the file, the type and the expiry', async () => {
    const text = await send(
      api,
      'post',
      `/students/${studentId}/documents?type=OTHER`,
      Buffer.from('not a file'),
      'application/pdf',
    );
    expect(text.status).toBe(422);
    const svg = await send(
      api,
      'post',
      `/students/${studentId}/documents?type=OTHER`,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'image/svg+xml',
    );
    expect(svg.status).toBe(422);
    const unknown = await send(
      api,
      'post',
      `/students/${studentId}/documents?type=NOPE`,
      PDF,
      'application/pdf',
    );
    expect(unknown.status).toBe(404);
    const expiry = await send(
      api,
      'post',
      `/students/${studentId}/documents?type=ADDRESS_PROOF&expires_on=2030-01-01`,
      PDF,
      'application/pdf',
    );
    expect(expiry.status).toBe(422);
    const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
    expect(
      (
        await send(
          api,
          'post',
          `/students/${studentId}/documents?type=OTHER`,
          big,
          'application/pdf',
        )
      ).status,
    ).toBe(422);
  });

  it('marks expired medical certificates and lets a document be removed', async () => {
    await send(
      api,
      'post',
      `/students/${studentId}/documents?type=MEDICAL_CERT&expires_on=2020-01-01`,
      PDF,
      'application/pdf',
    );
    const list = await api.get(`/students/${studentId}/documents`);
    const med = list.body.data.types.find((t: { code: string }) => t.code === 'MEDICAL_CERT');
    expect(med.status).toBe('EXPIRED');
    const del = await api.delete(`/students/${studentId}/documents/${med.documents[0].id}`);
    expect(del.status).toBe(204);
    const after = (await api.get(`/students/${studentId}/documents`)).body.data.types.find(
      (t: { code: string }) => t.code === 'MEDICAL_CERT',
    );
    expect(after.status).toBe('MISSING');
  });

  it('keeps another school out of the student and needs the documents permission', async () => {
    const foreign = await B.admin.api.get(`/students/${studentId}/documents`);
    expect(foreign.status).toBe(404);
    const acct = await h.addMember(api, [{ role_id: await h.roleId(api, 'ACCOUNTANT') }]);
    const denied = await acct.api.get(`/students/${studentId}/documents`);
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('PERMISSION_DENIED');
  });
});

describe('student photo', () => {
  it('sets, serves, replaces and removes a photo', async () => {
    const set = await send(
      api,
      'put',
      `/students/${studentId}/photo?filename=me.png`,
      PNG,
      'image/png',
    );
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const first = set.body.data.photo_file_id;
    expect((await api.get(`/students/${studentId}`)).body.data.photo_file_id).toBe(first);

    const got = await download(api, `/students/${studentId}/photo`);
    expect(got.status).toBe(200);
    expect((got.body as Buffer).equals(PNG)).toBe(true);

    const again = await send(
      api,
      'put',
      `/students/${studentId}/photo`,
      Buffer.concat([PNG, Buffer.from('x')]),
      'image/png',
    );
    expect(again.body.data.photo_file_id).not.toBe(first);

    expect((await api.delete(`/students/${studentId}/photo`)).status).toBe(204);
    expect((await api.get(`/students/${studentId}/photo`)).status).toBe(404);
  });

  it('refuses PDFs and oversize images as photos, and other schools', async () => {
    expect(
      (await send(api, 'put', `/students/${studentId}/photo`, PDF, 'application/pdf')).status,
    ).toBe(422);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await send(api, 'put', `/students/${studentId}/photo`, big, 'image/png')).status).toBe(
      422,
    );
    expect(
      (await send(B.admin.api, 'put', `/students/${studentId}/photo`, PNG, 'image/png')).status,
    ).toBe(404);
  });
});
