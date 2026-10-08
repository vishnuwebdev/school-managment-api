import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { code, createHarness, type Api, type Harness } from '../helpers.js';

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

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const upload = (a: Api, kind: string, body: Buffer, type = 'image/png') =>
  h.http
    .put(`/api/v1/tenants/current/branding/${kind}?filename=${kind}.png`)
    .set('Authorization', `Bearer ${a.token}`)
    .set('Content-Type', type)
    .send(body);

const bankBody = (over: object = {}) => ({
  account_holder: 'Vault Public School Trust',
  bank_name: 'State Bank of India',
  account_number: '123456789012',
  ifsc: 'SBIN0001234',
  ...over,
});

describe('profile and contact extras (§12.1–12.2)', () => {
  it('saves the extra fields, clears blanks, and enforces the version', async () => {
    const cur = (await api.get('/tenants/current')).body.data;
    expect(cur.profile.affiliation_board).toBeNull();

    const saved = await api.patch('/tenants/current', {
      version: cur.version,
      profile: {
        affiliation_board: 'CBSE',
        affiliation_number: '2730123',
        established_year: 1998,
        secondary_phone: '+91 98765 43210',
        alternate_email: 'office@school.test',
        motto: 'Learn to lead',
      },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.data.profile.affiliation_board).toBe('CBSE');
    expect(saved.body.data.profile.established_year).toBe(1998);

    // A stale version is refused.
    const stale = await api.patch('/tenants/current', {
      version: cur.version,
      profile: { motto: 'Other' },
    });
    expect(stale.status).toBe(409);

    // Blank clears the field; omitted fields stay.
    const cleared = await api.patch('/tenants/current', {
      version: saved.body.data.version,
      profile: { motto: '  ' },
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.profile.motto).toBeNull();
    expect(cleared.body.data.profile.affiliation_board).toBe('CBSE');

    const bad = await api.patch('/tenants/current', {
      version: cleared.body.data.version,
      profile: { established_year: 1200, secondary_phone: 'abc' },
    });
    expect(bad.status).toBe(422);
  });

  it('shows the extras in GET /tenants/current and writes an audit entry', async () => {
    const cur = (await api.get('/tenants/current')).body.data;
    expect(cur.profile.affiliation_number).toBe('2730123');
    const audit = await api.get('/audit-logs?action=TENANT_UPDATED');
    expect(audit.status).toBe(200);
  });
});

describe('branding files (§12.4)', () => {
  it('uploads a logo, serves it to the same school, and keeps it away from another', async () => {
    const res = await upload(api, 'logo', PNG);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const fileId = res.body.data.logo_file_id as string;
    expect(fileId).toBeTruthy();

    const got = await h.http
      .get(`/api/v1/files/${fileId}`)
      .set('Authorization', `Bearer ${api.token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toContain('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect((got.body as Buffer).equals(PNG)).toBe(true);

    const other = await B.admin.api.get(`/files/${fileId}`);
    expect(other.status).toBe(404);
  });

  it('replacing keeps one active logo; removing clears the pointer', async () => {
    const first = (await api.get('/tenants/current/settings')).body.data.logo_file_id;
    const again = await upload(api, 'logo', Buffer.concat([PNG, Buffer.from('x')]));
    expect(again.status).toBe(200);
    expect(again.body.data.logo_file_id).not.toBe(first);
    const del = await api.delete('/tenants/current/branding/logo');
    expect(del.status).toBe(200);
    expect(del.body.data.logo_file_id).toBeNull();
  });

  it('rejects non-images, active SVG, mismatched bytes and oversize files', async () => {
    const text = await upload(api, 'logo', Buffer.from('hello world'), 'image/png');
    expect(text.status).toBe(422);

    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const unsafe = await upload(api, 'logo', svg, 'image/svg+xml');
    expect(unsafe.status).toBe(422);

    const okSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    );
    expect((await upload(api, 'logo', okSvg, 'image/svg+xml')).status).toBe(200);

    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await upload(api, 'logo', big)).status).toBe(422);
    // The banner allows up to 5 MB.
    expect((await upload(api, 'banner', big)).status).toBe(200);
  });

  it('needs the settings permission', async () => {
    const reception = await h.addMember(api, [{ role_id: await h.roleId(api, 'RECEPTIONIST') }]);
    expect((await upload(reception.api, 'logo', PNG)).status).toBe(403);
  });
});

describe('bank accounts (§12.5)', () => {
  let accountId: string;

  it('adds an account: masked everywhere, first one becomes default, duplicates refused', async () => {
    const made = await api.post('/tenants/current/bank-accounts', bankBody());
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    accountId = made.body.data.id;
    expect(made.body.data.is_default).toBe(true);
    expect(made.body.data.account_number_masked).toBe('XXXX9012');
    expect(JSON.stringify(made.body)).not.toContain('123456789012');

    const dup = await api.post('/tenants/current/bank-accounts', bankBody());
    expect(dup.status).toBe(409);
    expect(code(dup)).toBe('DUPLICATE_RESOURCE');

    const bad = await api.post('/tenants/current/bank-accounts', bankBody({ ifsc: 'nope' }));
    expect(bad.status).toBe(422);
  });

  it('switches the default and refuses to remove it while others exist', async () => {
    const second = await api.post(
      '/tenants/current/bank-accounts',
      bankBody({ account_number: '998877665544', label: 'Transport' }),
    );
    expect(second.status).toBe(201);
    expect(second.body.data.is_default).toBe(false);

    const blocked = await api.post(`/tenants/current/bank-accounts/${accountId}/archive`, {
      reason: 'Closed account',
    });
    expect(blocked.status).toBe(422);

    const swap = await api.post(
      `/tenants/current/bank-accounts/${second.body.data.id}/make-default`,
    );
    expect(swap.body.data.is_default).toBe(true);
    const list = (await api.get('/tenants/current/bank-accounts')).body.data as {
      id: string;
      is_default: boolean;
    }[];
    expect(list.filter((a) => a.is_default)).toHaveLength(1);

    const archived = await api.post(`/tenants/current/bank-accounts/${accountId}/archive`, {
      reason: 'Closed account',
    });
    expect(archived.status).toBe(200);
  });

  it('edits with the version check and re-masks after a number change', async () => {
    const cur = (await api.get('/tenants/current/bank-accounts')).body.data[0];
    const upd = await api.patch(`/tenants/current/bank-accounts/${cur.id}`, {
      version: cur.version,
      account_number: '555566667777',
      branch_name: 'Connaught Place',
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.data.account_number_masked).toBe('XXXX7777');
    const stale = await api.patch(`/tenants/current/bank-accounts/${cur.id}`, {
      version: cur.version,
      bank_name: 'Axis Bank',
    });
    expect(stale.status).toBe(409);
  });

  it('reveals the full number only with the reveal permission, a reason, and an audit entry', async () => {
    const cur = (await api.get('/tenants/current/bank-accounts')).body.data[0];
    const noReason = await api.post(`/tenants/current/bank-accounts/${cur.id}/reveal`, {});
    expect(noReason.status).toBe(422);

    const shown = await api.post(`/tenants/current/bank-accounts/${cur.id}/reveal`, {
      reason: 'Preparing a bank letter',
    });
    expect(shown.status).toBe(200);
    expect(shown.body.data.account_number).toBe('555566667777');

    const audit = await api.get('/audit-logs?action=BANK_ACCOUNT_REVEALED');
    expect(audit.status).toBe(200);
    const text = JSON.stringify(audit.body);
    expect(text).toContain('BANK_ACCOUNT_REVEALED');
    expect(text).not.toContain('555566667777');
  });

  it('accountant sees masked numbers but cannot add, edit or reveal', async () => {
    const acct = await h.addMember(api, [{ role_id: await h.roleId(api, 'ACCOUNTANT') }]);
    const cur = (await api.get('/tenants/current/bank-accounts')).body.data[0];
    const list = await acct.api.get('/tenants/current/bank-accounts');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('555566667777');
    expect((await acct.api.post('/tenants/current/bank-accounts', bankBody())).status).toBe(403);
    expect(
      (
        await acct.api.post(`/tenants/current/bank-accounts/${cur.id}/reveal`, {
          reason: 'Just curious',
        })
      ).status,
    ).toBe(403);
  });

  it('principal can reveal; another school sees none of this school’s accounts', async () => {
    const principal = await h.addMember(api, [{ role_id: await h.roleId(api, 'PRINCIPAL') }]);
    const cur = (await api.get('/tenants/current/bank-accounts')).body.data[0];
    const shown = await principal.api.post(`/tenants/current/bank-accounts/${cur.id}/reveal`, {
      reason: 'Audit request',
    });
    expect(shown.status).toBe(200);
    expect((await B.admin.api.get('/tenants/current/bank-accounts')).body.data).toEqual([]);
    expect(
      (
        await B.admin.api.post(`/tenants/current/bank-accounts/${cur.id}/reveal`, {
          reason: 'Peek',
        })
      ).status,
    ).toBe(404);
  });
});

describe('registration details (§12.6)', () => {
  it('lists the India templates', async () => {
    const res = await api.get('/tenants/current/registrations');
    expect(res.status).toBe(200);
    const codes = res.body.data.types.map((t: { code: string }) => t.code);
    expect(codes).toEqual(
      expect.arrayContaining(['PAN', 'TAN', 'GSTIN', 'UDISE', 'SCHOOL_REGISTRATION', 'TRUST_NAME']),
    );
  });

  it('validates formats, normalises case, and updates in place', async () => {
    const bad = await api.put('/tenants/current/registrations/PAN', { value: '12345' });
    expect(bad.status).toBe(422);

    const ok = await api.put('/tenants/current/registrations/PAN', { value: ' aaapl1234c ' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.value).toBe('AAAPL1234C');

    expect(
      (await api.put('/tenants/current/registrations/GSTIN', { value: '07AAAPL1234C1Z5' })).status,
    ).toBe(200);
    expect((await api.put('/tenants/current/registrations/UDISE', { value: '123' })).status).toBe(
      422,
    );
    expect((await api.put('/tenants/current/registrations/NOPE', { value: 'x' })).status).toBe(404);

    const dates = await api.put('/tenants/current/registrations/SCHOOL_REGISTRATION', {
      value: 'REG/2001/77',
      issued_on: '2001-04-01',
      valid_until: '2000-01-01',
    });
    expect(dates.status).toBe(422);
    const fine = await api.put('/tenants/current/registrations/SCHOOL_REGISTRATION', {
      value: 'REG/2001/77',
      issued_on: '2001-04-01',
      valid_until: '2031-03-31',
      authority: 'State Education Board',
    });
    expect(fine.status).toBe(200);

    const again = await api.put('/tenants/current/registrations/PAN', { value: 'BBBPL1234D' });
    expect(again.body.data.value).toBe('BBBPL1234D');
    const list = (await api.get('/tenants/current/registrations')).body.data.items;
    expect(list.filter((i: { type: string }) => i.type === 'PAN')).toHaveLength(1);

    expect((await api.delete('/tenants/current/registrations/GSTIN')).status).toBe(204);
    expect((await api.delete('/tenants/current/registrations/GSTIN')).status).toBe(404);
  });

  it('is invisible to roles without finance access and isolated per school', async () => {
    const reception = await h.addMember(api, [{ role_id: await h.roleId(api, 'RECEPTIONIST') }]);
    expect((await reception.api.get('/tenants/current/registrations')).status).toBe(403);
    expect((await B.admin.api.get('/tenants/current/registrations')).body.data.items).toEqual([]);
  });
});

describe('setup status and document branding', () => {
  it('reports completeness with what is missing', async () => {
    const res = await api.get('/tenants/current/setup-status');
    expect(res.status).toBe(200);
    expect(res.body.data.percent).toBeGreaterThan(0);
    expect(res.body.data.percent).toBeLessThan(100);
    const bank = res.body.data.sections.find((s: { code: string }) => s.code === 'bank');
    expect(bank.done).toBe(1);
    const fresh = await B.admin.api.get('/tenants/current/setup-status');
    expect(fresh.body.data.percent).toBeLessThan(res.body.data.percent);
  });

  it('gives printed documents the default bank (masked) and registration numbers', async () => {
    const res = await api.get('/tenants/current/document-branding');
    expect(res.status).toBe(200);
    expect(res.body.data.bank.account_number_masked).toMatch(/^XXXX\d{4}$/);
    expect(res.body.data.registrations.PAN).toBe('BBBPL1234D');
    expect(JSON.stringify(res.body)).not.toContain('555566667777');
  });
});
